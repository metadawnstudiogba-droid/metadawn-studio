import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DEFAULT_TEMPLATE } from "../../../lib/builtin-templates";
import { store } from "../../../lib/store";
const mocks = vi.hoisted(() => ({ user: "", create: vi.fn(), getAssetStatus: vi.fn() }));
vi.mock("@/lib/auth-session", () => ({ requireUser: async () => ({ id: mocks.user }) }));
vi.mock("@/lib/storage", () => ({ getUserStorageConfig: async () => ({ config: {} }), presentGeneration: async (_storage: unknown, record: unknown) => record }));
vi.mock("@/lib/provider-config", () => ({ resolveProviderConfig: async () => ({ template: DEFAULT_TEMPLATE, credentials: { generationToken: "qa-only-key", assetToken: "qa-only-asset" }, endpoints: { generation: "https://api.example", assets: "https://api.example" }, parameters: {}, model: "qa", bindingId: `legacy:${mocks.user}` }) }));
vi.mock("@/lib/provider", async importOriginal => ({ ...await importOriginal<typeof import("../../../lib/provider")>(), TemplateProvider: class { createGeneration = mocks.create; getAssetStatus = mocks.getAssetStatus; } }));
vi.mock("@/lib/types", () => ({ MODEL_ID: "qa" }));
vi.mock("@/lib/validation", () => ({ validateGeneration: vi.fn() }));
import { POST } from "./route";
const input = { mode: "generate", prompt: "qa", ratio: "16:9", duration: 5, resolution: "720p", references: [] };
function request(id: string = randomUUID(), prompt = "qa") { return new Request("http://localhost/api/generations", { method: "POST", headers: { "Idempotency-Key": id }, body: JSON.stringify({ ...input, prompt }) }); }
beforeEach(async () => { vi.stubEnv("DATABASE_URL", undefined); mocks.user = randomUUID(); await store.saveProviderSettingsRow(mocks.user, { encryptedToken: "qa", baseUrl: "https://api.example", model: "qa", providerBindingId: `legacy:${mocks.user}` }); mocks.create.mockReset().mockImplementation(async () => ({ id: randomUUID() })); mocks.getAssetStatus.mockReset().mockResolvedValue("ready"); });
afterEach(() => vi.unstubAllEnvs());

it("reserves the task before contacting the provider and does not submit a replay twice", async () => {
  const id = randomUUID();
  mocks.create.mockImplementation(async () => {
    expect(await store.countActiveGenerations(mocks.user)).toBe(1);
    return { id: "qa-provider" };
  });
  const first = await POST(request(id)); const replay = await POST(request(id));
  expect(first.status).toBe(201); expect(replay.status).toBe(200);
  expect((await replay.json()).providerTaskId).toBe("qa-provider");
  expect(mocks.create).toHaveBeenCalledTimes(1);
});
it("returns 429 for concurrent submissions beyond two slots", async () => {
  const responses = await Promise.all(Array.from({ length: 8 }, () => POST(request())));
  expect(responses.filter(r => r.status === 201)).toHaveLength(2);
  expect(responses.filter(r => r.status === 429)).toHaveLength(6);
  expect(mocks.create).toHaveBeenCalledTimes(2);
});
it("keeps an uncertain submission reserved and never auto-submits its replay", async () => {
  const id = randomUUID(); mocks.create.mockRejectedValue(new Error("qa-provider-secret-detail"));
  const response = await POST(request(id)); expect(response.status).toBe(202);
  expect(await response.text()).not.toContain("qa-provider-secret-detail");
  expect(await store.countActiveGenerations(mocks.user)).toBe(1);
  expect((await POST(request(id))).status).toBe(200);
  expect(mocks.create).toHaveBeenCalledTimes(1);
});
it("rejects reused IDs with changed input and isolates the same ID across users", async () => {
  const id = randomUUID(); expect((await POST(request(id))).status).toBe(201);
  expect((await POST(request(id, "changed"))).status).toBe(409);
  mocks.user = randomUUID(); await store.saveProviderSettingsRow(mocks.user, { encryptedToken: "qa", baseUrl: "https://api.example", model: "qa", providerBindingId: `legacy:${mocks.user}` }); expect((await POST(request(id))).status).toBe(201);
  expect(mocks.create).toHaveBeenCalledTimes(2);
});
it("rejects missing or invalid request IDs before reserving or contacting the provider", async () => {
  expect((await POST(request("invalid"))).status).toBe(400);
  expect(await store.countActiveGenerations(mocks.user)).toBe(0);
  expect(mocks.create).not.toHaveBeenCalled();
});

it("refreshes a processing person asset and submits with the ready record", async () => {
  const asset = await store.createAsset(mocks.user, { name: "风灵", type: "image", purpose: "人物", sourceUrl: "https://media.example/person.png", providerBindingId: `legacy:${mocks.user}`, providerAssetId: "asset-person", providerStatus: "processing" });
  const response = await POST(new Request("http://localhost/api/generations", { method: "POST", headers: { "Idempotency-Key": randomUUID() }, body: JSON.stringify({ ...input, references: [{ assetId: asset.id, role: "identity" }] }) }));
  expect(response.status).toBe(201);
  expect(mocks.getAssetStatus).toHaveBeenCalledWith("asset-person");
  expect((await store.getAsset(mocks.user, asset.id))?.providerStatus).toBe("ready");
  expect(mocks.create.mock.calls[0][1].get(asset.id).providerStatus).toBe("ready");
});

it.each([
  ["processing", "仍在审核中"],
  ["failed", "登记审核失败"],
])("blocks a person asset when the refreshed status is %s", async (status, message) => {
  mocks.getAssetStatus.mockResolvedValue(status);
  const asset = await store.createAsset(mocks.user, { name: "风灵", type: "image", purpose: "人物", sourceUrl: "https://media.example/person.png", providerBindingId: `legacy:${mocks.user}`, providerAssetId: "asset-person", providerStatus: "processing" });
  const response = await POST(new Request("http://localhost/api/generations", { method: "POST", headers: { "Idempotency-Key": randomUUID() }, body: JSON.stringify({ ...input, references: [{ assetId: asset.id, role: "identity" }] }) }));
  expect(response.status).toBe(400);
  expect(await response.text()).toContain(message);
  expect(mocks.create).not.toHaveBeenCalled();
});

it("allows retry after a provider status query fails", async () => {
  const requestId = randomUUID();
  const asset = await store.createAsset(mocks.user, { name: "风灵", type: "image", purpose: "人物", sourceUrl: "https://media.example/person.png", providerBindingId: `legacy:${mocks.user}`, providerAssetId: "asset-person", providerStatus: "processing" });
  const makeRequest = () => new Request("http://localhost/api/generations", { method: "POST", headers: { "Idempotency-Key": requestId }, body: JSON.stringify({ ...input, references: [{ assetId: asset.id, role: "identity" }] }) });
  mocks.getAssetStatus.mockRejectedValueOnce(new Error("provider unavailable")).mockResolvedValueOnce("ready");
  const failed = await POST(makeRequest());
  expect(failed.status).toBe(400); expect(await failed.text()).toContain("状态同步失败");
  expect(await store.countActiveGenerations(mocks.user)).toBe(0);
  expect((await POST(makeRequest())).status).toBe(201);
});

it("explains that an unregistered person asset needs registration", async () => {
  const asset = await store.createAsset(mocks.user, { name: "风灵", type: "image", purpose: "人物", sourceUrl: "https://media.example/person.png" });
  const response = await POST(new Request("http://localhost/api/generations", { method: "POST", headers: { "Idempotency-Key": randomUUID() }, body: JSON.stringify({ ...input, references: [{ assetId: asset.id, role: "identity" }] }) }));
  expect(response.status).toBe(400); expect(await response.text()).toContain("登记");
  expect(mocks.getAssetStatus).not.toHaveBeenCalled(); expect(mocks.create).not.toHaveBeenCalled();
});
