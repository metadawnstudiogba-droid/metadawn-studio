import type { AssetRole, GenerationInput, ProviderTask, StudioAsset } from "./types";
import { evaluateTemplate, readPath, type ProviderTemplate, type TemplateOperation } from "./provider-template";
import { safeFetch, readJsonResponse } from "./safe-http";
import { volcengineHeaders } from "./volcengine-signature";
import { providerPrompt } from "./prompt-mentions";
import { resolveProviderUrl, type R2Config } from "./storage";

export interface ResolvedProviderConfig {
  template: ProviderTemplate;
  endpoints: Partial<Record<"generation" | "assets", string>>;
  parameters: Record<string, string>;
  credentials: Record<string, string>;
  model: string;
  bindingId: string;
  updatedAt?: string;
  revision?: string;
}

export class ProviderRejectedError extends Error {}

const first = (data: unknown, paths?: string[]) => paths?.map(path => readPath(data, path)).find(value => value !== undefined && value !== null);
const asText = (value: unknown) => typeof value === "string" || typeof value === "number" ? String(value) : undefined;

function roleFor(role: AssetRole, type: StudioAsset["type"], hasLastFrame: boolean) {
  if (role === "last_frame") return "last_frame";
  if (role === "first_frame") return hasLastFrame ? "first_frame" : "reference_image";
  return type === "video" ? "reference_video" : type === "audio" ? "reference_audio" : "reference_image";
}

export function hasPurposeCredentials(config: ResolvedProviderConfig, purpose: "generation" | "assets") {
  const keys = Object.entries(config.template.credentials).filter(([, spec]) => spec.purpose === purpose).map(([key]) => key);
  return keys.length > 0 && keys.every(key => Boolean(config.credentials[key]))
    && Object.entries(config.template.parameters ?? {}).every(([key, spec]) => spec.purpose !== purpose || !spec.required || Boolean(config.parameters[key]));
}

/** Imported JSON can describe data mappings, but cannot run code or access secrets. */
export class TemplateProvider {
  constructor(readonly config: ResolvedProviderConfig, private readonly storage?: R2Config) {}

  private safeMessage(value: unknown) {
    let message = asText(value) ?? "供应商接口返回错误。";
    for (const secret of Object.values(this.config.credentials)) {
      if (!secret) continue;
      for (const form of [secret, encodeURIComponent(secret)]) message = message.split(form).join("[已隐藏]");
    }
    return message.replace(/https?:\/\/\S+/gi, "[接口地址]").slice(0, 500);
  }

  private async request(name: keyof ProviderTemplate["operations"], context: Record<string, unknown>) {
    const operation = this.config.template.operations[name];
    if (!operation) throw new Error("当前供应商模板不支持此功能。");
    if (!hasPurposeCredentials(this.config, operation.endpoint)) throw new Error("请先填写此接口需要的凭证及参数。");
    const base = this.config.endpoints[operation.endpoint];
    if (!base) throw new Error("接口地址未配置。");
    // Only same-purpose, non-secret parameters are available to expressions.
    const parameters = Object.fromEntries(Object.entries(this.config.parameters).filter(([key]) => this.config.template.parameters?.[key]?.purpose === operation.endpoint));
    const values = { ...context, parameters };
    const path = operation.path.replace(/\{([^}]+)\}/g, (_, field: string) => {
      const value = asText(readPath(values, field));
      if (!value || value === "." || value === "..") throw new Error("接口路径缺少有效参数。");
      return encodeURIComponent(value);
    });
    const url = new URL(`${base.replace(/\/$/, "")}${path}`);
    if (url.origin !== new URL(base).origin) throw new Error("接口路径不能改变凭证的目标地址。");
    const query = operation.query ? evaluateTemplate(operation.query, values) as Record<string, unknown> : {};
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined) continue;
      if (typeof value === "object") throw new Error("查询参数必须是文字、数字或布尔值。");
      url.searchParams.set(key, String(value));
    }
    const payload = operation.body === undefined ? undefined : evaluateTemplate(operation.body, values);
    const body = payload === undefined ? undefined : operation.encoding === "form"
      ? new URLSearchParams(Object.entries(payload as Record<string, unknown>).map(([key, value]) => [key, typeof value === "object" ? JSON.stringify(value) : String(value)])).toString()
      : JSON.stringify(payload);
    if (body && Buffer.byteLength(body) > 1024 * 1024) throw new Error("接口请求超过 1 MB。");
    const headers: Record<string, string> = { "Content-Type": operation.encoding === "form" ? "application/x-www-form-urlencoded" : "application/json" };
    const auth = operation.auth;
    if (auth.type === "volcengine") Object.assign(headers, volcengineHeaders({ url, method: operation.method, body: body ?? "", accessKeyId: this.config.credentials[auth.accessKeyId], secretAccessKey: this.config.credentials[auth.secretAccessKey], region: auth.region, service: auth.service }));
    else if (auth.type === "bearer") headers.Authorization = `Bearer ${this.config.credentials[auth.credential]}`;
    else if (auth.type === "header") headers[auth.name] = this.config.credentials[auth.credential];
    else url.searchParams.set(auth.name, this.config.credentials[auth.credential]);
    let response: Response;
    try { response = await safeFetch(url, { method: operation.method, headers, body, signal: AbortSignal.timeout(60_000) }); }
    catch { throw new Error("供应商连接失败或超时，请检查 API 地址及供应商状态。"); }
    const data = await readJsonResponse(response);
    const mapping = operation.response;
    const failed = mapping.failure && readPath(data, mapping.failure.path) === mapping.failure.equals;
    const controlError = readPath(data, "ResponseMetadata.Error");
    if (!response.ok || failed || controlError) {
      const message = this.safeMessage(first(data, mapping.error) ?? `供应商请求失败（${response.status}）。`);
      if (failed || controlError || response.status >= 400 && response.status < 500 && response.status !== 408) throw new ProviderRejectedError(message);
      throw new Error(message);
    }
    return { data, mapping };
  }

  private state(data: unknown, mapping: TemplateOperation["response"]): ProviderTask["status"] {
    const status = asText(first(data, mapping.status))?.trim().toLowerCase();
    return status && mapping.states?.[status] || "WAITING";
  }

  async createGeneration(input: GenerationInput, assets: Map<string, StudioAsset>) {
    const prompt = providerPrompt(input.prompt, input.references, assets);
    const hasLastFrame = input.references.some(ref => ref.role === "last_frame");
    const references = await Promise.all(input.references.map(async ref => {
      const asset = assets.get(ref.assetId);
      if (!asset) throw new Error("引用素材不存在。");
      const bound = asset.providerBindingId === this.config.bindingId;
      const url = bound && asset.providerStatus === "ready" && asset.providerAssetId
        ? `asset://${asset.providerAssetId.replace(/^asset:\/\//, "")}`
        : this.storage ? await resolveProviderUrl(this.storage, asset.sourceUrl) : asset.sourceUrl;
      return { id: asset.id, name: asset.name, type: asset.type, url, role: ref.role, providerRole: roleFor(ref.role, asset.type, hasLastFrame) };
    }));
    const content: Record<string, unknown>[] = references.map(ref => ({ type: `${ref.type}_url`, [`${ref.type}_url`]: { url: ref.url }, role: ref.providerRole }));
    content.push({ type: "text", text: prompt });
    const { data, mapping } = await this.request("createGeneration", { input: { ...input, model: input.model ?? this.config.model, prompt }, references, content });
    const id = asText(first(data, mapping.id));
    if (!id || id.length > 512) throw new Error("供应商未返回有效任务 ID；请核对供应商控制台，勿重复提交。");
    return { id };
  }

  async getTask(taskId: string): Promise<ProviderTask> {
    const { data, mapping } = await this.request("getTask", { task: { id: taskId } });
    const returnedId = asText(first(data, mapping.id));
    if (returnedId && returnedId !== taskId) throw new Error("供应商返回的任务 ID 不匹配。");
    // Preserve numerical usage metrics, never arbitrary echoed request objects.
    const rawUsage = first(data, mapping.usage);
    const usage = rawUsage && typeof rawUsage === "object" && !Array.isArray(rawUsage)
      ? Object.fromEntries(Object.entries(rawUsage).filter(([key, value]) => /^[a-zA-Z0-9_]{1,80}$/.test(key) && typeof value === "number" && Number.isFinite(value))) : undefined;
    return { id: taskId, status: this.state(data, mapping), videoUrl: asText(first(data, mapping.videoUrl)), errorMessage: first(data, mapping.error) === undefined ? undefined : this.safeMessage(first(data, mapping.error)), usage };
  }

  async registerAsset(asset: StudioAsset) {
    const url = this.storage ? await resolveProviderUrl(this.storage, asset.sourceUrl) : asset.sourceUrl;
    const { data, mapping } = await this.request("registerAsset", { asset: { id: asset.id, name: asset.name, type: asset.type, providerType: asset.type[0].toUpperCase() + asset.type.slice(1), purpose: asset.purpose, url } });
    const assetId = asText(first(data, mapping.id));
    if (!assetId || assetId.length > 512) throw new Error("供应商未返回素材 ID，请在供应商控制台核对登记结果。");
    const state = this.state(data, mapping);
    return { assetId, status: state === "SUCCESS" ? "ready" as const : state === "FAILURE" ? "failed" as const : "processing" as const };
  }

  async getAssetStatus(assetId: string): Promise<StudioAsset["providerStatus"]> {
    const { data, mapping } = await this.request("getAsset", { asset: { id: assetId } });
    const returnedId = asText(first(data, mapping.id));
    if (returnedId && returnedId !== assetId) throw new Error("供应商返回的素材 ID 不匹配。");
    const state = this.state(data, mapping);
    return state === "SUCCESS" ? "ready" : state === "FAILURE" ? "failed" : "processing";
  }
}
