import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { decryptSecret, encryptSecret } from "./secrets";
import { store, providerRowRevision } from "./store";
import { DEFAULT_TEMPLATE } from "./builtin-templates";
import { validateProviderTemplate, validateEndpointUrl, type ProviderSettingsInput, type ProviderSettingsStatus } from "./provider-template";
import { TemplateProvider, hasPurposeCredentials, type ResolvedProviderConfig } from "./provider";
import { assertPublicUrl } from "./safe-http";
import { HttpError } from "./http-error";

function defaults() {
  return Object.fromEntries(Object.entries(DEFAULT_TEMPLATE.endpoints).map(([key, endpoint]) => [key, endpoint.defaultUrl]));
}

export async function resolveProviderConfig(userId: string): Promise<ResolvedProviderConfig> {
  const row = await store.getProviderSettingsRow(userId);
  const bindingId = row?.providerBindingId ?? `legacy:${userId}`;
  if (row?.adapterConfig && row.encryptedCredentials) {
    return { ...row.adapterConfig, template: validateProviderTemplate(row.adapterConfig.template), credentials: JSON.parse(decryptSecret(row.encryptedCredentials, `provider:${userId}:${bindingId}:v1`)), model: row.model, bindingId, updatedAt: row.updatedAt, revision: providerRowRevision(row) };
  }
  const token = row?.encryptedToken ? decryptSecret(row.encryptedToken, `kkidc:${userId}:v1`) : "";
  return { template: DEFAULT_TEMPLATE, endpoints: row ? { generation: row.baseUrl, assets: row.baseUrl } : defaults(), parameters: {}, credentials: token ? { generationToken: token, assetToken: token } : {}, model: row?.model ?? DEFAULT_TEMPLATE.models[0].id, bindingId, updatedAt: row?.updatedAt, revision: providerRowRevision(row) };
}

export async function getProviderConfigStatus(userId: string): Promise<ProviderSettingsStatus> {
  const config = await resolveProviderConfig(userId);
  const hints = Object.fromEntries(Object.keys(config.template.credentials).map(key => [key, config.credentials[key] ? `•••• ${config.credentials[key].slice(-4)}` : ""]));
  return { configured: hasPurposeCredentials(config, "generation"), source: config.updatedAt ? "web_persistent" : "none", persistent: Boolean(config.updatedAt), tokenHint: hints.generationToken ?? "", baseUrl: config.endpoints.generation ?? "", model: config.model, bindingId: config.bindingId, template: config.template, endpoints: config.endpoints, parameters: config.parameters, credentialHints: hints, canRegisterAssets: Boolean(config.template.operations.registerAsset) && hasPurposeCredentials(config, "assets"), locked: await store.providerIsBusy(userId), updatedAt: config.updatedAt };
}

export async function saveProviderConfig(userId: string, input: ProviderSettingsInput) {
  const template = validateProviderTemplate(input.template);
  const current = await resolveProviderConfig(userId);
  if (input.expectedBindingId && input.expectedBindingId !== current.bindingId) throw new HttpError(409, "供应商设置已改变，请刷新后重试。");
  if (!template.models.some(model => model.id === input.model)) throw new Error("请选择模板支持的模型。");
  const endpoints: ResolvedProviderConfig["endpoints"] = {};
  for (const [key, spec] of Object.entries(template.endpoints)) {
    const name = key as "generation" | "assets";
    endpoints[name] = validateEndpointUrl(input.endpoints?.[name] || spec.defaultUrl);
    await assertPublicUrl(endpoints[name]);
  }
  const sameDestination = isDeepStrictEqual(current.template, template) && isDeepStrictEqual(current.endpoints, endpoints);
  const credentials: Record<string, string> = {};
  for (const key of Object.keys(template.credentials)) {
    const supplied = input.credentials?.[key];
    if (supplied !== undefined && typeof supplied !== "string") throw new Error("凭证格式无效。");
    const value = supplied?.trim() || (sameDestination ? current.credentials[key] : "");
    if (value) {
      if (value.length < 8 || value.length > 8192 || /[\u0000-\u0020\u007f]/.test(value)) throw new Error("凭证长度或格式无效。");
      credentials[key] = value;
    }
  }
  const parameters: Record<string, string> = {};
  for (const [key, spec] of Object.entries(template.parameters ?? {})) {
    const value = input.parameters?.[key] ?? spec.default ?? "";
    if (typeof value !== "string" || value.length > 2000 || /[\u0000-\u001f]/.test(value)) throw new Error("接口参数格式无效。");
    parameters[key] = value.trim();
  }
  const config = { template, endpoints, credentials, parameters, model: input.model, bindingId: current.bindingId };
  if (!hasPurposeCredentials(config, "generation")) throw new Error("请填写生成接口所需的凭证和参数。");
  const assetKeys = Object.entries(template.credentials).filter(([, spec]) => spec.purpose === "assets").map(([key]) => key);
  if (assetKeys.some(key => credentials[key]) && !hasPurposeCredentials(config, "assets")) throw new Error("素材登记凭证已部分填写，请补齐凭证及必填参数，或暂时全部留空。");
  const sameService = sameDestination && isDeepStrictEqual(current.parameters, parameters);
  const sameCredentials = isDeepStrictEqual(current.credentials, credentials);
  let preserveBinding = sameService && sameCredentials && Boolean(current.updatedAt);
  const taskProofs: Record<string, string> = {}; const assetProofs: Record<string, string> = {};
  if (input.repairCredentials && !preserveBinding) {
    if (!sameService || !current.updatedAt) throw new Error("修复凭证时请保留原模板、API 地址和参数。");
    const tasks = (await store.listGenerations(userId)).filter(task => ["WAITING_PROVIDER", "ARCHIVING", "STORAGE_ERROR"].includes(task.status));
    const assets = (await store.listAssets(userId)).filter(asset => asset.providerStatus === "processing");
    for (const task of tasks.filter(task => !task.providerTaskId)) {
      const proof = input.verificationTasks?.[task.id];
      if (typeof proof !== "string" || !proof.trim() || proof.length > 512) throw new Error("请填写供应商控制台中的待确认任务 ID，或先确认该任务未创建。");
      taskProofs[task.id] = proof.trim();
    }
    for (const asset of assets.filter(asset => !asset.providerAssetId)) {
      const proof = input.verificationAssets?.[asset.id];
      if (typeof proof !== "string" || !proof.trim() || proof.length > 512) throw new Error("请填写供应商控制台中的待确认素材 ID，或先确认该素材未登记。");
      assetProofs[asset.id] = proof.trim();
    }
    if (!tasks.length && !assets.length) throw new Error("当前没有待完成任务，请直接保存新设置。");
    const provider = new TemplateProvider(config);
    // Read-only ownership checks. No paid submission is performed during repair.
    for (const task of tasks) await provider.getTask(task.providerTaskId ?? taskProofs[task.id]);
    for (const asset of assets) await provider.getAssetStatus(asset.providerAssetId ?? assetProofs[asset.id]);
    // Check every changed credential purpose against at least one existing item.
    const changed = new Set(Object.keys(template.credentials).filter(key => current.credentials[key] !== credentials[key]).map(key => template.credentials[key].purpose));
    if (changed.has("generation") && !tasks.length || changed.has("assets") && !assets.length) throw new Error("修改的凭证缺少原账户的待完成记录，暂时无法验证，请等待当前任务完成。");
    preserveBinding = true;
  }
  const bindingId = preserveBinding ? current.bindingId : randomUUID();
  await store.saveProviderSettingsRow(userId, {
    encryptedToken: template.id === "kkidc" && credentials.generationToken ? encryptSecret(credentials.generationToken, `kkidc:${userId}:v1`) : "",
    baseUrl: endpoints.generation!, model: input.model, adapterConfig: { template, endpoints, parameters },
    encryptedCredentials: encryptSecret(JSON.stringify(credentials), `provider:${userId}:${bindingId}:v1`), providerBindingId: bindingId,
  }, { expectedUpdatedAt: current.updatedAt, expectedRevision: current.revision, preserveBinding, taskProofs, assetProofs });
  return getProviderConfigStatus(userId);
}

export async function clearProviderConfig(userId: string) { await store.deleteProviderSettingsRow(userId); return getProviderConfigStatus(userId); }

// Compatibility helpers for existing KKIDC clients and the encryption regression.
export async function resolveKkidcConfig(userId: string) {
  const config = await resolveProviderConfig(userId);
  return { token: config.template.id === "kkidc" ? config.credentials.generationToken ?? "" : "", baseUrl: config.endpoints.generation ?? "", model: config.model, source: config.updatedAt ? "web_persistent" as const : "none" as const, updatedAt: config.updatedAt };
}
export async function saveKkidcConfig(userId: string, input: { token: string; baseUrl?: string }) {
  if (input.baseUrl && validateEndpointUrl(input.baseUrl) !== DEFAULT_TEMPLATE.endpoints.generation!.defaultUrl) throw new Error("旧版 KKIDC 设置接口不支持自定义地址，请使用供应商模板。");
  return saveProviderConfig(userId, { template: DEFAULT_TEMPLATE, endpoints: defaults(), model: DEFAULT_TEMPLATE.models[0].id, credentials: { generationToken: input.token, assetToken: input.token }, parameters: {} });
}
export const getKkidcConfigStatus = getProviderConfigStatus;
export const clearKkidcConfig = clearProviderConfig;

// Kept for the small cryptography regression test; production paths use user-bound AAD above.
export function encryptProviderToken(token: string, secret: string) { const iv = randomBytes(12); const cipher = createCipheriv("aes-256-gcm", createHash("sha256").update(secret).digest(), iv); const encrypted = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]); return `v1:${iv.toString("base64")}:${cipher.getAuthTag().toString("base64")}:${encrypted.toString("base64")}`; }
export function decryptProviderToken(payload: string, secret: string) { const [version, iv, tag, encrypted] = payload.split(":"); if (version !== "v1" || !iv || !tag || !encrypted) throw new Error("已保存的 API Key 格式无效。"); const decipher = createDecipheriv("aes-256-gcm", createHash("sha256").update(secret).digest(), Buffer.from(iv, "base64")); decipher.setAuthTag(Buffer.from(tag, "base64")); return Buffer.concat([decipher.update(Buffer.from(encrypted, "base64")), decipher.final()]).toString("utf8"); }
