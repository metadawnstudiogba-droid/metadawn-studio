import { beforeEach, expect, it, vi } from "vitest";
import { BUILTIN_TEMPLATES, DEFAULT_TEMPLATE } from "./builtin-templates";
import { TemplateProvider, ProviderRejectedError, type ResolvedProviderConfig } from "./provider";
import { volcengineHeaders } from "./volcengine-signature";
import type { GenerationInput, StudioAsset } from "./types";

const transport = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock("./safe-http", async importOriginal => ({ ...await importOriginal<typeof import("./safe-http")>(), safeFetch: transport.fetch }));
const config = (index = 0): ResolvedProviderConfig => ({ template: BUILTIN_TEMPLATES[index], endpoints: Object.fromEntries(Object.entries(BUILTIN_TEMPLATES[index].endpoints).map(([key, value]) => [key, value.defaultUrl])), parameters: { assetGroupId: "group-example", assetProjectName: "default" }, credentials: { generationToken: "generation-secret-example", assetToken: "asset-secret-example", assetAccessKeyId: "EXAMPLE_ACCESS_KEY", assetSecretAccessKey: "example-secret-key-never-real" }, model: DEFAULT_TEMPLATE.models[0].id, bindingId: "binding-current" });
const input: GenerationInput = { model: DEFAULT_TEMPLATE.models[0].id, mode: "generate", prompt: "Use @图片1", ratio: "16:9", resolution: "720p", duration: 10, generateAudio: true, references: [{ assetId: "asset-a", role: "identity" }] };
const asset: StudioAsset = { id: "asset-a", name: "example", purpose: "人物", type: "image", sourceUrl: "https://media.example.com/a.png", providerAssetId: "registered-a", providerBindingId: "binding-current", providerStatus: "ready", createdAt: "2026-01-01T00:00:00Z" };
beforeEach(() => { transport.fetch.mockReset().mockResolvedValue(Response.json({ id: "task-a", status: "queued" })); });

it.each([0, 1])("uses the paired adapter's generation request and excludes every credential from its body: %s", async index => {
  await new TemplateProvider(config(index)).createGeneration(input, new Map([[asset.id, asset]]));
  const [url, init] = transport.fetch.mock.calls[0];
  expect(String(url)).toBe(index === 0 ? "https://ai-api.kkidc.com/sd/api/v3/contents/generations/tasks" : "https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks");
  expect(init.headers.Authorization).toBe("Bearer generation-secret-example");
  const body = JSON.parse(init.body);
  expect(body.content[0].image_url.url).toBe("asset://registered-a");
  expect(body.content.at(-1).type).toBe("text");
  for (const secret of Object.values(config(index).credentials)) expect(init.body).not.toContain(secret);
  if (index === 1) expect(body).not.toHaveProperty("prompt");
});

it("does not reuse an asset ID registered under another account", async () => {
  await new TemplateProvider(config()).createGeneration(input, new Map([[asset.id, { ...asset, providerBindingId: "old-account" }]]));
  const body = JSON.parse(transport.fetch.mock.calls[0][1].body);
  expect(body.content[0].image_url.url).toBe(asset.sourceUrl);
  expect(JSON.stringify(body)).not.toContain("registered-a");
});

it("uses a separate asset credential and the Ark control-plane signature", async () => {
  transport.fetch.mockResolvedValueOnce(Response.json({ data: { asset_id: "asset-new", status: "ready" } }));
  expect(await new TemplateProvider(config()).registerAsset(asset)).toMatchObject({ assetId: "asset-new", status: "ready" });
  expect(transport.fetch.mock.calls[0][1].headers.Authorization).toBe("Bearer asset-secret-example");
  transport.fetch.mockResolvedValueOnce(Response.json({ Result: { Id: "ark-asset" } }));
  expect(await new TemplateProvider(config(1)).registerAsset(asset)).toMatchObject({ assetId: "ark-asset", status: "processing" });
  const [url, init] = transport.fetch.mock.calls[1];
  expect(new URL(url).searchParams.get("Action")).toBe("CreateAsset");
  expect(JSON.parse(init.body)).toEqual({ AssetType: "Image", URL: asset.sourceUrl, Name: asset.name, GroupId: "group-example", ProjectName: "default" });
  expect(init.headers.Authorization).toContain("Credential=EXAMPLE_ACCESS_KEY/");
  expect(JSON.stringify(init)).not.toContain("generation-secret-example");
});

it("matches the official Volcengine Node SDK signing fixture", () => {
  // Fixture generated with signRequest from the official SDK, 2026-09-11:
  // https://github.com/volcengine/volcengine-nodejs-sdk/blob/master/packages/sdk-core/src/utils/signer.ts
  const result = volcengineHeaders({ url: new URL("https://ark.cn-beijing.volcengineapi.com/?Action=GetAsset&Version=2024-01-01"), method: "POST", body: '{"Id":"asset-example","ProjectName":"default"}', accessKeyId: "EXAMPLE_ACCESS_KEY", secretAccessKey: "example-secret-key-never-real", region: "cn-beijing", service: "ark", now: new Date("2026-09-11T12:00:00Z") });
  expect(result.Authorization).toBe("HMAC-SHA256 Credential=EXAMPLE_ACCESS_KEY/20260911/cn-beijing/ark/request, SignedHeaders=host;x-content-sha256;x-date, Signature=e550bc9e148923a356214124a7421667d3de41190e3873d43549e203f896341c");
});

it("maps responses, refuses mismatched task IDs, and redacts echoed secrets", async () => {
  transport.fetch.mockResolvedValueOnce(Response.json({ id: "task-a", status: "succeeded", content: { video_url: "https://media.example.com/a.mp4" }, usage: { total_tokens: 123, echoed_token: "secret" } }));
  expect(await new TemplateProvider(config()).getTask("task-a")).toMatchObject({ id: "task-a", status: "SUCCESS", usage: { total_tokens: 123 } });
  transport.fetch.mockResolvedValueOnce(Response.json({ id: "task-other", status: "succeeded" }));
  await expect(new TemplateProvider(config()).getTask("task-a")).rejects.toThrow("不匹配");
  transport.fetch.mockResolvedValueOnce(Response.json({ error: { message: "invalid generation-secret-example" } }, { status: 401 }));
  await expect(new TemplateProvider(config()).getTask("task-a")).rejects.toThrow("invalid [已隐藏]");
  transport.fetch.mockResolvedValueOnce(Response.json({ ResponseMetadata: { Error: { Message: "No permission" } } }));
  await expect(new TemplateProvider(config(1)).registerAsset(asset)).rejects.toBeInstanceOf(ProviderRejectedError);
});
