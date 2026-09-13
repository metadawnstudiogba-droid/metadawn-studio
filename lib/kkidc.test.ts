import { afterEach, describe, expect, it, vi } from "vitest";
import { KkidcSeedanceProvider, normaliseAssetStatus } from "./kkidc";
import type { GenerationInput, StudioAsset } from "./types";

const asset: StudioAsset = { id: "video-1", name: "motion", type: "video", purpose: "动作", sourceUrl: "https://media.example/motion.mp4", providerStatus: "ready", createdAt: new Date().toISOString() };
const input: GenerationInput = { mode: "generate", prompt: "A product turns toward camera", ratio: "16:9", duration: 30, resolution: "720p", generateAudio: true, references: [{ assetId: asset.id, role: "motion" }] };

afterEach(() => vi.unstubAllGlobals());

describe("KKIDC Seedance provider", () => {
  it.each([
    [" ready ", "ready"], ["SUCCEEDED", "ready"], [" rejected ", "failed"], ["unknown-new-status", "processing"], [undefined, "processing"],
  ])("normalises asset status %s as %s", (status, expected) => {
    expect(normaliseAssetStatus(status)).toBe(expected);
  });
  it("resolves picker tokens to ordered media labels in both provider prompt fields", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ id: "task-mentions" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const image: StudioAsset = { ...asset, id: "image-1", type: "image", name: "风灵", providerStatus: "temporary", sourceUrl: "https://media.example/frame.png" };
    const prompt = "@图片1 转身，动作参考@视频1，@风灵";
    const provider = new KkidcSeedanceProvider({ KKIDC_API_TOKEN: "t", KKIDC_API_BASE: "https://api.example" });
    await provider.createGeneration({ ...input, prompt, references: [...input.references, { assetId: image.id, role: "identity" }] }, new Map([[asset.id, asset], [image.id, image]]));
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.prompt).toBe("图片1 转身，动作参考视频1，@风灵");
    expect(body.content).toEqual([
      expect.objectContaining({ type: "video_url" }),
      expect.objectContaining({ type: "image_url" }),
      { type: "text", text: body.prompt },
    ]);
  });
  it("uses the server-side task endpoint and maps video references", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ id: "task-1" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const provider = new KkidcSeedanceProvider({ KKIDC_API_TOKEN: "server-only-token", KKIDC_API_BASE: "https://api.example", KKIDC_SEEDANCE_MODEL: "doubao-seedance-2-5-260628" });
    const result = await provider.createGeneration(input, new Map([[asset.id, asset]]));
    expect(result.id).toBe("task-1");
    expect(fetchMock).toHaveBeenCalledWith("https://api.example/sd/api/v3/contents/generations/tasks", expect.objectContaining({ method: "POST" }));
    const request = fetchMock.mock.calls[0][1] as RequestInit;
    expect(request.headers).toMatchObject({ Authorization: "Bearer server-only-token" });
    expect(JSON.parse(request.body as string).content[0]).toMatchObject({ type: "video_url", role: "reference_video" });
  });
  it("uses the model selected by the generation form", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ id: "task-model" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const provider = new KkidcSeedanceProvider({ KKIDC_API_TOKEN: "t", KKIDC_API_BASE: "https://api.example", KKIDC_SEEDANCE_MODEL: "fallback-model" });
    await provider.createGeneration({ ...input, model: "doubao-seedance-2-0-260128" }, new Map([[asset.id, asset]]));
    const request = fetchMock.mock.calls[0][1] as RequestInit;
    expect(JSON.parse(request.body as string).model).toBe("doubao-seedance-2-0-260128");
  });
  it("uses an approved asset id instead of the original URL", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ id: "task-asset" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const approvedAsset: StudioAsset = { ...asset, providerAssetId: "mat-approved-video", providerStatus: "ready" };
    const provider = new KkidcSeedanceProvider({ KKIDC_API_TOKEN: "t", KKIDC_API_BASE: "https://api.example" });
    await provider.createGeneration(input, new Map([[asset.id, approvedAsset]]));
    const request = fetchMock.mock.calls[0][1] as RequestInit;
    expect(JSON.parse(request.body as string).content[0].video_url.url).toBe("asset://mat-approved-video");
  });
  it("maps a standalone first frame as reference_image", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ id: "task-frame" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const image: StudioAsset = { ...asset, id: "image-1", type: "image", sourceUrl: "https://media.example/frame.png" };
    const frameInput: GenerationInput = { ...input, references: [{ assetId: image.id, role: "first_frame" }] };
    const provider = new KkidcSeedanceProvider({ KKIDC_API_TOKEN: "t", KKIDC_API_BASE: "https://api.example" });
    await provider.createGeneration(frameInput, new Map([[image.id, image]]));
    const request = fetchMock.mock.calls[0][1] as RequestInit;
    expect(JSON.parse(request.body as string).content[0]).toMatchObject({ type: "image_url", role: "reference_image" });
  });
  it("uses first_frame and last_frame roles when both are supplied", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ id: "task-frames" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const first: StudioAsset = { ...asset, id: "first", type: "image", sourceUrl: "https://media.example/first.png" };
    const last: StudioAsset = { ...asset, id: "last", type: "image", sourceUrl: "https://media.example/last.png" };
    const frameInput: GenerationInput = { ...input, references: [{ assetId: first.id, role: "first_frame" }, { assetId: last.id, role: "last_frame" }] };
    const provider = new KkidcSeedanceProvider({ KKIDC_API_TOKEN: "t", KKIDC_API_BASE: "https://api.example" });
    await provider.createGeneration(frameInput, new Map([[first.id, first], [last.id, last]]));
    const request = fetchMock.mock.calls[0][1] as RequestInit;
    expect(JSON.parse(request.body as string).content.slice(0, 2).map((item: { role: string }) => item.role)).toEqual(["first_frame", "last_frame"]);
  });
  it("rejects a successful HTTP response with a failed business status", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ success: false, message: "素材审核失败" }), { status: 200 })));
    const provider = new KkidcSeedanceProvider({ KKIDC_API_TOKEN: "t", KKIDC_API_BASE: "https://api.example" });
    await expect(provider.registerAsset(asset)).rejects.toThrow("素材审核失败");
  });
  it("normalises completed provider status", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ id: "task-1", status: "succeeded", content: { video_url: "https://video.example/out.mp4" } }), { status: 200 })));
    const provider = new KkidcSeedanceProvider({ KKIDC_API_TOKEN: "t", KKIDC_API_BASE: "https://api.example" });
    await expect(provider.getTask("task-1")).resolves.toMatchObject({ status: "SUCCESS", videoUrl: "https://video.example/out.mp4" });
  });
});
