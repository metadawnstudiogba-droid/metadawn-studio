import { afterEach, describe, expect, it, vi } from "vitest";
import { assertR2ObjectExists, createPresignedAssetUpload, deleteStoredAsset, mirrorRemoteVideo, parseR2Uri, resolveStoredUrl, saveUserStorageSettings, toR2Uri, type R2Config } from "./storage";
import { store, type StorageSettingsRow } from "./store";

vi.mock("./safe-http", () => ({ safeFetch: (url: string, init: RequestInit) => fetch(url, init) }));
const config: R2Config = { accountId: "1234567890abcdef1234567890abcdef", bucket: "seedance-private", jurisdiction: "default", namespace: "test-namespace", accessKeyId: "test-access-key", secretAccessKey: "test-secret-key" };
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe("user-owned private R2 storage", () => {
  it("creates a tenant-namespaced, content-type-bound upload URL", async () => {
    vi.stubEnv("SETTINGS_ENCRYPTION_KEY", "qa-only-upload-key");
    const result = await createPresignedAssetUpload(config, { filename: "人物 参考.png", contentType: "image/png", size: 1024 }, "qa-a");
    const url = new URL(result.uploadUrl);
    expect(url.hostname).toBe("1234567890abcdef1234567890abcdef.r2.cloudflarestorage.com");
    expect(url.pathname).toContain("/seedance-private/seedance/test-namespace/assets/");
    expect(url.searchParams.get("X-Amz-Expires")).toBe("900");
    expect(url.searchParams.get("X-Amz-SignedHeaders")).toContain("content-type");
  });

  it("only signs objects in the current workspace", async () => {
    const reference = toR2Uri(config, "seedance/test-namespace/assets/example.png");
    expect(parseR2Uri(reference)).toEqual({ bucket: "seedance-private", key: "seedance/test-namespace/assets/example.png" });
    expect(new URL(await resolveStoredUrl(config, reference)).searchParams.get("X-Amz-Signature")).toBeTruthy();
    await expect(resolveStoredUrl(config, "r2://seedance-private/seedance/other/assets/example.png")).rejects.toThrow("当前工作区");
  });

  it("does not delete a generation through the asset helper", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 204 })));
    await expect(deleteStoredAsset(config, "r2://seedance-private/seedance/test-namespace/generations/example.mp4")).rejects.toThrow("仅允许删除");
    vi.unstubAllGlobals();
  });
});

describe("upload receipts and archive integrity", () => {
  async function upload() {
    vi.stubEnv("SETTINGS_ENCRYPTION_KEY", "qa-only-upload-key");
    return createPresignedAssetUpload(config, { filename: "qa.png", contentType: "image/png", size: 4 }, "qa-a");
  }
  it("accepts exact HEAD metadata but rejects missing, wrong size, and wrong MIME", async () => {
    const signed = await upload();
    const fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockResolvedValue(new Response(null, { headers: { "Content-Length": "4", "Content-Type": "image/png" } }));
    await expect(assertR2ObjectExists(config, signed.objectKey, signed.uploadReceipt, "qa-a", "image")).resolves.toBeUndefined();
    for (const headers of [{}, { "Content-Length": "5", "Content-Type": "image/png" }, { "Content-Length": "4", "Content-Type": "video/mp4" }] as HeadersInit[]) {
      fetchMock.mockResolvedValue(new Response(null, { headers }));
      await expect(assertR2ObjectExists(config, signed.objectKey, signed.uploadReceipt, "qa-a", "image")).rejects.toThrow("大小或类型");
    }
  });
  it("rejects tampering, expiration, other tenants, other keys and account identities before network", async () => {
    const signed = await upload(); const fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock);
    for (const token of [undefined, "bad", signed.uploadReceipt.slice(0, -5)]) await expect(assertR2ObjectExists(config, signed.objectKey, token, "qa-a", "image")).rejects.toThrow("上传凭证");
    await expect(assertR2ObjectExists(config, signed.objectKey, signed.uploadReceipt, "qa-b", "image")).rejects.toThrow("上传凭证");
    await expect(assertR2ObjectExists(config, signed.objectKey + "x", signed.uploadReceipt, "qa-a", "image")).rejects.toThrow("上传凭证");
    await expect(assertR2ObjectExists({ ...config, accountId: "a".repeat(32) }, signed.objectKey, signed.uploadReceipt, "qa-a", "image")).rejects.toThrow("上传凭证");
    await expect(assertR2ObjectExists(config, signed.objectKey, signed.uploadReceipt, "qa-a", "video")).rejects.toThrow("上传凭证");
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 901000);
    await expect(assertR2ObjectExists(config, signed.objectKey, signed.uploadReceipt, "qa-a", "image")).rejects.toThrow("上传凭证");
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("enforces the integer 5 GiB admission limit", async () => {
    vi.stubEnv("SETTINGS_ENCRYPTION_KEY", "qa-only-upload-key");
    for (const size of [0, 1.5, Infinity, 5 * 1024 ** 3 + 1]) await expect(createPresignedAssetUpload(config, { filename: "qa.mp4", contentType: "video/mp4", size }, "qa-a")).rejects.toThrow("5 GiB");
    await expect(createPresignedAssetUpload(config, { filename: "qa.mp4", contentType: "video/mp4", size: 5 * 1024 ** 3 }, "qa-a")).resolves.toHaveProperty("uploadReceipt");
  });
  it.each(["ok", "head-size", "head-mime", "source-size"])("streams without buffering and validates archive: %s", async scenario => {
    const methods: string[] = [];
    const putRequests: Array<{ url: string; headers: Headers }> = [];
    vi.stubGlobal("fetch", vi.fn(async (url: unknown, init?: RequestInit) => {
      methods.push(init?.method || "GET");
      if (!init?.method) return new Response(new Uint8Array([1, 2, 3, 4]), { headers: { "Content-Type": "video/mp4", "Content-Length": scenario === "source-size" ? "5" : "4" } });
      if (init.method === "PUT") {
        putRequests.push({ url: String(url), headers: new Headers(init.headers) });
        const reader = (init.body as ReadableStream<Uint8Array>).getReader();
        while (!(await reader.read()).done) { /* consume the actual test stream */ }
        return new Response(null);
      }
      return new Response(null, { headers: { "Content-Length": scenario === "head-size" ? "3" : "4", "Content-Type": scenario === "head-mime" ? "image/png" : "video/mp4" } });
    }));
    const result = mirrorRemoteVideo(config, "https://qa-media.invalid/qa.mp4", "qa-id");
    if (scenario === "ok") await expect(result).resolves.toContain("generations/qa-id.mp4");
    else await expect(result).rejects.toThrow(scenario === "source-size" ? "长度不完整" : "完整归档");
    expect(methods).toEqual(scenario === "source-size" ? ["GET", "PUT"] : ["GET", "PUT", "HEAD"]);
    expect(putRequests[0].headers.get("content-length")).toBe(scenario === "source-size" ? "5" : "4");
    expect(new URL(putRequests[0].url).searchParams.get("X-Amz-SignedHeaders")).toContain("content-length");
  });
  it("rejects an unknown provider length before starting an R2 upload", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(new Uint8Array([1]), { headers: { "Content-Type": "video/mp4" } }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(mirrorRemoteVideo(config, "https://qa-media.invalid/qa.mp4", "qa-id")).rejects.toThrow("Content-Length");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it("rejects FedRAMP before any network calls", async () => {
    const fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock);
    await expect(saveUserStorageSettings("qa-a", { ...config, jurisdiction: "fedramp" })).rejects.toMatchObject({ status: 400 });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("legacy R2 identity reconnect", () => {
  function setup(placeholder: boolean, hasContent = true) {
    let row: StorageSettingsRow | undefined = placeholder ? { userId: "qa-owner", accountId: config.accountId, bucket: config.bucket, jurisdiction: config.jurisdiction, namespace: config.namespace, encryptedCredentials: null, state: "disconnected", updatedAt: new Date().toISOString() } : undefined;
    vi.spyOn(store, "getStorageSettingsRow").mockImplementation(async () => row);
    vi.spyOn(store, "listAssets").mockResolvedValue(hasContent ? [{ id: "legacy", name: "qa", type: "image", purpose: "", sourceUrl: "r2://seedance-private/assets/old.png", providerStatus: "unregistered", createdAt: new Date().toISOString() }] : []);
    vi.spyOn(store, "listGenerations").mockResolvedValue([]);
    const save = vi.spyOn(store, "saveStorageSettingsRow").mockImplementation(async value => { row = value; });
    const fetchStub = vi.fn(async (_target: string | URL | Request, _init?: RequestInit) => new Response("<ListBucketResult><Contents><Key>assets/old.png</Key></Contents></ListBucketResult>"));
    vi.stubGlobal("fetch", fetchStub);
    vi.stubEnv("SETTINGS_ENCRYPTION_KEY", "qa-only-encryption-key");
    return { fetchStub, save };
  }

  it("rejects content without a trusted identity before any network or save", async () => {
    const { fetchStub, save } = setup(false);
    await expect(saveUserStorageSettings("qa-owner", config)).rejects.toThrow("缺少原 Bucket 身份");
    expect(fetchStub).not.toHaveBeenCalled(); expect(save).not.toHaveBeenCalled();
  });

  it("reconnects a trusted nonempty legacy bucket but still requires CORS", async () => {
    const { fetchStub, save } = setup(true);
    const result = await saveUserStorageSettings("qa-owner", config);
    expect(fetchStub.mock.calls.map(call => call[1]?.method)).toEqual(["GET", "PUT", "HEAD", "GET", "DELETE"]);
    expect(result.state).toBe("needs_cors"); expect(result.configured).toBe(false);
    expect(save.mock.calls[0][0].namespace).toBe(config.namespace);
    expect(save.mock.calls[0][0].encryptedCredentials).toMatch(/^v2:/);
  });

  it.each(["accountId", "bucket", "jurisdiction"] as const)("rejects changed %s for a populated placeholder", async field => {
    const { fetchStub, save } = setup(true);
    const changed = { ...config, [field]: field === "accountId" ? "a".repeat(32) : field === "bucket" ? "different-bucket" : "eu" };
    await expect(saveUserStorageSettings("qa-owner", changed)).rejects.toThrow("不能更换 Bucket");
    expect(fetchStub).not.toHaveBeenCalled(); expect(save).not.toHaveBeenCalled();
  });

  it("keeps the empty-bucket rule for first-time users", async () => {
    const { fetchStub, save } = setup(false, false);
    await expect(saveUserStorageSettings("qa-owner", config)).rejects.toThrow("空白");
    expect(fetchStub).toHaveBeenCalledTimes(1); expect(save).not.toHaveBeenCalled();
  });
});
