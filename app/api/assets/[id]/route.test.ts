import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getAsset: vi.fn(),
  countGenerationsUsingAsset: vi.fn(),
  deleteAsset: vi.fn(),
  deleteStoredAsset: vi.fn(),
  requireUser: vi.fn(),
  getUserStorageConfig: vi.fn(),
}));

vi.mock("@/lib/store", () => ({
  store: {
    getAsset: mocks.getAsset,
    countGenerationsUsingAsset: mocks.countGenerationsUsingAsset,
    deleteAsset: mocks.deleteAsset,
  },
}));

vi.mock("@/lib/storage", () => ({ deleteStoredAsset: mocks.deleteStoredAsset, getUserStorageConfig: mocks.getUserStorageConfig }));
vi.mock("@/lib/auth-session", () => ({ requireUser: mocks.requireUser }));

import { DELETE } from "./route";

const asset = {
  id: "asset-1",
  name: "人物参考",
  type: "image",
  purpose: "主体",
  sourceUrl: "r2://seedance-private/assets/example.png",
  providerStatus: "unregistered",
  createdAt: new Date().toISOString(),
};

describe("DELETE /api/assets/:id", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getAsset.mockResolvedValue(asset);
    mocks.requireUser.mockResolvedValue({ id: "user-1" });
    mocks.getUserStorageConfig.mockResolvedValue({ config: { bucket: "seedance-private" } });
    mocks.countGenerationsUsingAsset.mockResolvedValue(0);
    mocks.deleteStoredAsset.mockResolvedValue(true);
    mocks.deleteAsset.mockResolvedValue(asset);
  });

  it("deletes the R2 object before removing the asset record", async () => {
    const response = await DELETE(new Request("http://localhost/api/assets/asset-1", { method: "DELETE" }), { params: Promise.resolve({ id: "asset-1" }) });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ id: "asset-1", deletedFromR2: true });
    expect(mocks.deleteStoredAsset).toHaveBeenCalledWith({ bucket: "seedance-private" }, asset.sourceUrl);
    expect(mocks.deleteAsset).toHaveBeenCalledWith("user-1", asset.id);
    expect(mocks.deleteStoredAsset.mock.invocationCallOrder[0]).toBeLessThan(mocks.deleteAsset.mock.invocationCallOrder[0]);
  });

  it("keeps both copies when a generation references the asset", async () => {
    mocks.countGenerationsUsingAsset.mockResolvedValue(2);
    const response = await DELETE(new Request("http://localhost/api/assets/asset-1", { method: "DELETE" }), { params: Promise.resolve({ id: "asset-1" }) });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: expect.stringContaining("2 个生成任务") });
    expect(mocks.deleteStoredAsset).not.toHaveBeenCalled();
    expect(mocks.deleteAsset).not.toHaveBeenCalled();
  });
});
