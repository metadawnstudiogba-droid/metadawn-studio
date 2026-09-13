import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getGeneration: vi.fn(),
  countChildGenerations: vi.fn(),
  deleteGeneration: vi.fn(),
  deleteStoredGeneration: vi.fn(),
  requireUser: vi.fn(),
  getUserStorageConfig: vi.fn(),
}));

vi.mock("@/lib/store", () => ({ store: {
  getGeneration: mocks.getGeneration,
  countChildGenerations: mocks.countChildGenerations,
  deleteGeneration: mocks.deleteGeneration,
} }));

vi.mock("@/lib/storage", () => ({
  deleteStoredGeneration: mocks.deleteStoredGeneration,
  mirrorRemoteVideo: vi.fn(),
  presentGeneration: vi.fn((value) => value),
  getUserStorageConfig: mocks.getUserStorageConfig,
}));

vi.mock("@/lib/auth-session", () => ({ requireUser: mocks.requireUser }));

vi.mock("@/lib/kkidc", () => ({ KkidcSeedanceProvider: vi.fn() }));
vi.mock("@/lib/provider-config", () => ({ resolveKkidcConfig: vi.fn() }));

import { DELETE } from "./route";

const generation = {
  id: "generation-1",
  mode: "generate",
  model: "doubao-seedance-2-5-260628",
  prompt: "测试作品",
  input: { mode: "generate", prompt: "测试作品", ratio: "9:16", duration: 5, resolution: "720p", generateAudio: true, references: [] },
  status: "SUCCESS",
  savedVideoUrl: "r2://seedance-private/generations/generation-1.mp4",
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

describe("DELETE /api/generations/:id", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getGeneration.mockResolvedValue(generation);
    mocks.requireUser.mockResolvedValue({ id: "user-1" });
    mocks.getUserStorageConfig.mockResolvedValue({ config: { bucket: "seedance-private" } });
    mocks.countChildGenerations.mockResolvedValue(0);
    mocks.deleteStoredGeneration.mockResolvedValue(true);
    mocks.deleteGeneration.mockResolvedValue(generation);
  });

  it("deletes the archived R2 video before deleting the work record", async () => {
    const response = await DELETE(new Request("http://localhost/api/generations/generation-1", { method: "DELETE" }), { params: Promise.resolve({ id: "generation-1" }) });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ id: "generation-1", deletedFromR2: true });
    expect(mocks.deleteStoredGeneration).toHaveBeenCalledWith({ bucket: "seedance-private" }, generation.savedVideoUrl);
    expect(mocks.deleteStoredGeneration.mock.invocationCallOrder[0]).toBeLessThan(mocks.deleteGeneration.mock.invocationCallOrder[0]);
  });

  it("keeps a work that already has an extension chain", async () => {
    mocks.countChildGenerations.mockResolvedValue(1);
    const response = await DELETE(new Request("http://localhost/api/generations/generation-1", { method: "DELETE" }), { params: Promise.resolve({ id: "generation-1" }) });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: expect.stringContaining("延长任务") });
    expect(mocks.deleteStoredGeneration).not.toHaveBeenCalled();
    expect(mocks.deleteGeneration).not.toHaveBeenCalled();
  });

  it("does not delete an active generation", async () => {
    mocks.getGeneration.mockResolvedValue({ ...generation, status: "WAITING_PROVIDER" });
    const response = await DELETE(new Request("http://localhost/api/generations/generation-1", { method: "DELETE" }), { params: Promise.resolve({ id: "generation-1" }) });
    expect(response.status).toBe(409);
    expect(mocks.deleteGeneration).not.toHaveBeenCalled();
  });
});
