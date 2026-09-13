import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DEFAULT_TEMPLATE } from "../../../../../lib/builtin-templates";
import { store } from "../../../../../lib/store";

const mocks = vi.hoisted(() => ({ user: "", register: vi.fn(), status: vi.fn() }));
vi.mock("@/lib/auth-session", () => ({ requireUser: async () => ({ id: mocks.user }) }));
vi.mock("@/lib/storage", () => ({ getUserStorageConfig: async () => ({ config: {} }), presentAsset: async (_storage: unknown, asset: unknown) => asset }));
vi.mock("@/lib/provider-config", () => ({ resolveProviderConfig: async () => ({ template: DEFAULT_TEMPLATE, credentials: { generationToken: "qa-only-key", assetToken: "qa-only-asset" }, endpoints: { generation: "https://api.example", assets: "https://api.example" }, parameters: {}, model: "qa", bindingId: `legacy:${mocks.user}` }) }));
vi.mock("@/lib/provider", async importOriginal => ({ ...await importOriginal<typeof import("../../../../../lib/provider")>(), TemplateProvider: class { registerAsset = mocks.register; getAssetStatus = mocks.status; } }));

import { GET, POST } from "./route";

beforeEach(async () => {
  vi.stubEnv("DATABASE_URL", undefined); mocks.user = randomUUID(); await store.saveProviderSettingsRow(mocks.user, { encryptedToken: "qa", baseUrl: "https://api.example", model: "qa", providerBindingId: `legacy:${mocks.user}` });
  mocks.register.mockReset().mockResolvedValue({ assetId: "asset-new", status: "processing" });
  mocks.status.mockReset().mockResolvedValue("ready");
});
afterEach(() => vi.unstubAllEnvs());

it("refreshes an existing provider asset without registering it again", async () => {
  const asset = await store.createAsset(mocks.user, { name: "风灵", type: "image", purpose: "人物", sourceUrl: "https://media.example/person.png", providerBindingId: `legacy:${mocks.user}`, providerAssetId: "asset-existing", providerStatus: "processing" });
  const response = await GET(new Request("http://localhost"), { params: Promise.resolve({ id: asset.id }) });
  expect(response.status).toBe(200); expect((await response.json()).providerStatus).toBe("ready");
  expect(mocks.status).toHaveBeenCalledWith("asset-existing"); expect(mocks.register).not.toHaveBeenCalled();
});

it("registers an asset without a provider id", async () => {
  const asset = await store.createAsset(mocks.user, { name: "风灵", type: "image", purpose: "人物", sourceUrl: "https://media.example/person.png" });
  const response = await POST(new Request("http://localhost"), { params: Promise.resolve({ id: asset.id }) });
  expect(response.status).toBe(200); expect((await response.json()).providerAssetId).toBe("asset-new");
  expect(mocks.register).toHaveBeenCalledOnce(); expect(mocks.status).not.toHaveBeenCalled();
});
