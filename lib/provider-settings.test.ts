import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DEFAULT_TEMPLATE, BUILTIN_TEMPLATES } from "./builtin-templates";
import { store } from "./store";
import { encryptSecret } from "./secrets";
import { saveProviderConfig, resolveProviderConfig, getProviderConfigStatus, clearProviderConfig } from "./provider-config";
import type { ProviderSettingsInput } from "./provider-template";
import type { GenerationRecord } from "./types";

const mocks = vi.hoisted(() => ({ task: vi.fn(), asset: vi.fn() }));
vi.mock("./safe-http", async importOriginal => ({ ...await importOriginal<typeof import("./safe-http")>(), assertPublicUrl: async (url: string) => new URL(url) }));
vi.mock("./provider", async importOriginal => ({ ...await importOriginal<typeof import("./provider")>(), TemplateProvider: class { getTask = mocks.task; getAssetStatus = mocks.asset; } }));
let user: string;
beforeEach(() => { user = randomUUID(); vi.stubEnv("DATABASE_URL", undefined); vi.stubEnv("SETTINGS_ENCRYPTION_KEY", "test-only-workspace-master-key"); mocks.task.mockReset().mockResolvedValue({ id: "existing-task", status: "WAITING" }); mocks.asset.mockReset().mockResolvedValue("processing"); });
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });
function settings(index = 0): ProviderSettingsInput {
  const template = BUILTIN_TEMPLATES[index];
  return { template, endpoints: Object.fromEntries(Object.entries(template.endpoints).map(([key, spec]) => [key, spec.defaultUrl])), parameters: {}, credentials: { generationToken: "example-generation-token", ...(index === 0 ? { assetToken: "example-asset-token" } : {}) }, model: template.models[0].id };
}
async function task(status: GenerationRecord["status"] = "WAITING_PROVIDER", providerTaskId: string | undefined = "existing-task") {
  const config = await resolveProviderConfig(user);
  const input = { model: config.model, mode: "generate" as const, prompt: "example", ratio: "16:9" as const, duration: 10, resolution: "720p" as const, generateAudio: true, references: [] };
  return store.createGeneration(user, { id: randomUUID(), providerTaskId, providerBindingId: config.bindingId, model: config.model, mode: input.mode, prompt: input.prompt, input, status, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" });
}

it("migrates the legacy key into two encrypted credential slots without changing the binding", async () => {
  await store.saveProviderSettingsRow(user, { encryptedToken: encryptSecret("legacy-example-token", `kkidc:${user}:v1`), baseUrl: DEFAULT_TEMPLATE.endpoints.generation!.defaultUrl, model: DEFAULT_TEMPLATE.models[0].id, providerBindingId: `legacy:${user}` });
  const legacy = await resolveProviderConfig(user);
  expect(legacy.credentials).toEqual({ generationToken: "legacy-example-token", assetToken: "legacy-example-token" });
  const result = await saveProviderConfig(user, { ...settings(), credentials: {} });
  expect(result.bindingId).toBe(legacy.bindingId);
  const row = await store.getProviderSettingsRow(user);
  expect(row?.encryptedCredentials).toMatch(/^v2:/); expect(JSON.stringify(row)).not.toContain("legacy-example-token");
  expect(JSON.stringify(result)).not.toContain("legacy-example-token");
  const different = randomUUID();
  await store.saveProviderSettingsRow(different, { ...row!, providerBindingId: legacy.bindingId, adapterConfig: undefined });
  await expect(resolveProviderConfig(different)).rejects.toThrow();
});

it.each(["WAITING_PROVIDER", "ARCHIVING", "STORAGE_ERROR"] as const)("blocks replacements and deletion while a %s task exists", async status => {
  const original = await saveProviderConfig(user, settings()); await task(status);
  await expect(saveProviderConfig(user, settings(1))).rejects.toMatchObject({ status: 409 });
  await expect(clearProviderConfig(user)).rejects.toMatchObject({ status: 409 });
  expect((await getProviderConfigStatus(user)).bindingId).toBe(original.bindingId);
});

it("reserves against the expected provider binding and preserves completed history across a switch", async () => {
  const first = await saveProviderConfig(user, settings()); const completed = await task("READY");
  const second = await saveProviderConfig(user, settings(1)); expect(second.bindingId).not.toBe(first.bindingId);
  const stale = { ...completed, id: randomUUID(), status: "WAITING_PROVIDER" as const };
  await expect(store.reserveGeneration(user, stale)).rejects.toMatchObject({ status: 409 });
  expect((await store.getGeneration(user, completed.id))?.providerBindingId).toBe(first.bindingId);
  await expect(saveProviderConfig(user, { ...settings(), endpoints: { generation: "https://another.example.com", assets: "https://another.example.com" }, credentials: {} })).rejects.toThrow("凭证");
});

it("serializes simultaneous configuration edits instead of losing an update", async () => {
  await saveProviderConfig(user, settings());
  const edits = await Promise.allSettled([saveProviderConfig(user, { ...settings(), credentials: { generationToken: "first-example-token" } }), saveProviderConfig(user, { ...settings(), credentials: { generationToken: "second-example-token" } })]);
  expect(edits.filter(result => result.status === "fulfilled")).toHaveLength(1);
  expect(edits.filter(result => result.status === "rejected")).toHaveLength(1);
});

it("blocks provider changes during registration and permits only a verified repair of the original account", async () => {
  const original = await saveProviderConfig(user, settings());
  const asset = await store.createAsset(user, { name: "example", type: "image", purpose: "人物", sourceUrl: "https://example.com/a.png" });
  await store.beginAssetRegistration(user, asset.id, original.bindingId);
  await store.updateAssetRegistration(user, asset.id, "existing-asset", "processing", original.bindingId);
  await expect(saveProviderConfig(user, settings(1))).rejects.toMatchObject({ status: 409 });
  mocks.asset.mockRejectedValueOnce(new Error("wrong account"));
  const repair = { ...settings(), credentials: { assetToken: "repaired-example-token" }, repairCredentials: true };
  await expect(saveProviderConfig(user, repair)).rejects.toThrow("wrong account");
  const repaired = await saveProviderConfig(user, repair);
  expect(repaired.bindingId).toBe(original.bindingId); expect(mocks.asset).toHaveBeenCalledWith("existing-asset");
  expect((await resolveProviderConfig(user)).credentials.generationToken).toBe("example-generation-token");
});

it("requires an explicit, aged confirmation to release an unknown submission and never resubmits it", async () => {
  const original = await saveProviderConfig(user, settings()); const pending = await task("WAITING_PROVIDER", "");
  // A missing ID is stored as undefined, just like a transport timeout.
  await store.createGeneration(user, { ...pending, providerTaskId: undefined });
  await expect(store.resolveUnknownGeneration("another-user", pending.id, original.bindingId)).rejects.toThrow();
  const resolved = await store.resolveUnknownGeneration(user, pending.id, original.bindingId);
  expect(resolved.status).toBe("FAILURE"); expect(resolved.errorMessage).toContain("用户已");
  expect(mocks.task).not.toHaveBeenCalled();
  expect((await store.reserveGeneration(user, { ...pending, providerTaskId: undefined })).created).toBe(false);
});
