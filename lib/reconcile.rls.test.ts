import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GenerationRecord } from "./types";
import { launchPolicy } from "./launch";

const mocks = vi.hoisted(() => ({
  getGeneration: vi.fn(), updateGeneration: vi.fn(), claimGenerationArchiving: vi.fn(), claimGenerationArchiveWorker: vi.fn(), markGenerationStorageError: vi.fn(),
  listPendingGenerationRefs: vi.fn(), getUserStorageConfig: vi.fn(),
  resolveProviderConfig: vi.fn(), getTask: vi.fn(), mirrorRemoteVideo: vi.fn(), fetch: vi.fn(),
}));
vi.mock("./store", () => ({ store: mocks }));
vi.mock("./storage", () => ({ getUserStorageConfig: mocks.getUserStorageConfig, mirrorRemoteVideo: mocks.mirrorRemoteVideo }));
vi.mock("./provider-config", () => ({ resolveProviderConfig: mocks.resolveProviderConfig }));
vi.mock("./provider", () => ({ hasPurposeCredentials: () => true, TemplateProvider: class { getTask = mocks.getTask; } }));

import { dispatchArchive, pollAndDispatch, reconcileInBackground, retryStorageArchive } from "./reconcile";
import background from "../netlify/functions/reconcile-background";
import scheduled from "../netlify/functions/reconcile-scheduled";

const fixture: GenerationRecord = {
  id: "generation-b", providerTaskId: "provider-task-b", mode: "generate", model: "test-model", prompt: "QA only",
  input: { mode: "generate", prompt: "QA only", ratio: "16:9", duration: 5, resolution: "720p", generateAudio: false, references: [] },
  status: "WAITING_PROVIDER", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
};

describe("tenant-bound reconciliation", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    launchPolicy.phase = "public";
    vi.stubGlobal("fetch", mocks.fetch);
    vi.stubGlobal("Netlify", { env: { get: () => "qa-cron-secret" } });
    vi.stubEnv("NETLIFY", "true");
  });
  afterEach(() => { launchPolicy.phase = "public"; vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

  it("rejects a mismatched user/task before credentials, provider, storage or dispatch", async () => {
    mocks.getGeneration.mockImplementation(async (userId: string, id: string) => userId === "user-b" && id === fixture.id ? fixture : undefined);
    expect(await reconcileInBackground("user-a", fixture.id)).toBeUndefined();
    await dispatchArchive("user-a", fixture.id);
    await expect(retryStorageArchive("user-a", fixture.id)).rejects.toThrow("此任务当前不能重新归档");
    for (const mock of [mocks.getUserStorageConfig, mocks.resolveProviderConfig, mocks.getTask, mocks.mirrorRemoteVideo, mocks.fetch, mocks.updateGeneration, mocks.claimGenerationArchiving, mocks.claimGenerationArchiveWorker, mocks.markGenerationStorageError]) expect(mock).not.toHaveBeenCalled();
  });

  it.each([
    ["poll", "WAITING_PROVIDER", pollAndDispatch],
    ["background wait", "WAITING_PROVIDER", reconcileInBackground],
    ["background archive", "ARCHIVING", reconcileInBackground],
  ] as const)("makes failed R2 lookup retryable for %s", async (_name, status, run) => {
    let generation: GenerationRecord = { ...fixture, status };
    mocks.getGeneration.mockImplementation(async () => generation);
    mocks.getUserStorageConfig.mockRejectedValue(new Error("qa-secret-detail-do-not-expose"));
    mocks.markGenerationStorageError.mockImplementation(async (_user, _id, from, errorMessage) => {
      if (generation.status !== from) return undefined;
      return generation = { ...generation, status: "STORAGE_ERROR", errorMessage };
    });
    expect(await run("user-b", fixture.id)).toMatchObject({ status: "STORAGE_ERROR", errorMessage: "R2 连接失效，请重新连接后重试归档。" });
    expect(mocks.markGenerationStorageError).toHaveBeenCalledWith("user-b", fixture.id, status, expect.not.stringContaining("qa-secret-detail"));
    expect(mocks.getTask).not.toHaveBeenCalled();
    expect(mocks.resolveProviderConfig).not.toHaveBeenCalled();
    await expect(retryStorageArchive("user-b", fixture.id)).rejects.toThrow();
    expect(mocks.claimGenerationArchiving).not.toHaveBeenCalled();
    mocks.getUserStorageConfig.mockResolvedValue({ config: {} });
    mocks.claimGenerationArchiving.mockImplementation(async () => generation = { ...generation, status: "ARCHIVING" });
    vi.stubEnv("URL", "https://site.example.invalid");
    vi.stubEnv("CRON_SECRET", "qa-only");
    mocks.fetch.mockResolvedValue(new Response(null, { status: 202 }));
    expect(await retryStorageArchive("user-b", fixture.id)).toMatchObject({ status: "ARCHIVING" });
  });

  it("does not classify a provider error as a storage failure", async () => {
    mocks.getGeneration.mockResolvedValue(fixture);
    mocks.getUserStorageConfig.mockResolvedValue({ config: {} });
    mocks.resolveProviderConfig.mockResolvedValue({ bindingId: "legacy:user-b" });
    mocks.getTask.mockRejectedValue(new Error("Provider unavailable"));
    await expect(pollAndDispatch("user-b", fixture.id)).rejects.toThrow("Provider unavailable");
    expect(mocks.markGenerationStorageError).not.toHaveBeenCalled();
  });

  it("dispatches with the documented runtime site identity even without NETLIFY", async () => {
    vi.stubEnv("NETLIFY", undefined);
    vi.stubEnv("SITE_ID", "qa-site");
    vi.stubEnv("URL", "https://site.example.invalid");
    vi.stubEnv("CRON_SECRET", "qa-only");
    mocks.getGeneration.mockResolvedValue({ ...fixture, status: "ARCHIVING" });
    mocks.fetch.mockResolvedValue(new Response(null, { status: 202 }));
    await dispatchArchive("user-b", fixture.id);
    expect(mocks.fetch).toHaveBeenCalledOnce();
    expect(mocks.getUserStorageConfig).not.toHaveBeenCalled();
    expect(mocks.mirrorRemoteVideo).not.toHaveBeenCalled();
  });

  it("archives the matching tenant using the same user for every store operation", async () => {
    let generation = { ...fixture };
    const storage = { namespace: "qa-b", bucket: "qa-private" };
    mocks.getGeneration.mockImplementation(async (userId: string) => userId === "user-b" ? generation : undefined);
    mocks.getUserStorageConfig.mockResolvedValue({ config: storage });
    mocks.resolveProviderConfig.mockResolvedValue({ bindingId: "legacy:user-b" });
    mocks.getTask.mockResolvedValue({ status: "SUCCESS", videoUrl: "https://provider.example.invalid/qa.mp4" });
    mocks.claimGenerationArchiving.mockImplementation(async () => generation = { ...generation, status: "ARCHIVING" });
    mocks.claimGenerationArchiveWorker.mockImplementation(async () => generation);
    mocks.updateGeneration.mockImplementation(async (_user: string, _id: string, patch: Partial<GenerationRecord>) => generation = { ...generation, ...patch });
    mocks.mirrorRemoteVideo.mockResolvedValue("r2://qa-private/seedance/qa-b/generations/qa.mp4");
    expect(await reconcileInBackground("user-b", fixture.id)).toMatchObject({ status: "READY" });
    for (const mock of [mocks.getGeneration, mocks.getUserStorageConfig, mocks.resolveProviderConfig, mocks.claimGenerationArchiving, mocks.claimGenerationArchiveWorker, mocks.updateGeneration]) {
      expect(mock).toHaveBeenCalled();
      expect(mock.mock.calls.every(([userId]) => userId === "user-b")).toBe(true);
    }
    expect(mocks.mirrorRemoteVideo).toHaveBeenCalledWith(storage, "https://provider.example.invalid/qa.mp4", fixture.id);
  });

  it("allows only one background worker to archive the same generation", async () => {
    let generation: GenerationRecord = { ...fixture, status: "ARCHIVING" };
    mocks.getGeneration.mockImplementation(async () => generation);
    mocks.getUserStorageConfig.mockResolvedValue({ config: {} });
    mocks.resolveProviderConfig.mockResolvedValue({ bindingId: "legacy:user-b" });
    mocks.getTask.mockResolvedValue({ status: "SUCCESS", videoUrl: "https://provider.example.invalid/qa.mp4" });
    mocks.claimGenerationArchiveWorker.mockResolvedValueOnce(generation).mockResolvedValue(undefined);
    mocks.mirrorRemoteVideo.mockResolvedValue("r2://qa-private/generations/qa.mp4");
    mocks.updateGeneration.mockImplementation(async (_user: string, _id: string, patch: Partial<GenerationRecord>) => generation = { ...generation, ...patch });
    await Promise.all([reconcileInBackground("user-b", fixture.id), reconcileInBackground("user-b", fixture.id)]);
    expect(mocks.claimGenerationArchiveWorker).toHaveBeenCalledTimes(2);
    expect(mocks.mirrorRemoteVideo).toHaveBeenCalledTimes(1);
  });

  it("fails closed for an unset cron secret and validates internal request boundaries", async () => {
    vi.stubGlobal("Netlify", { env: { get: () => undefined } });
    const denied = await background(new Request("https://site.example.invalid", { method: "POST", headers: { Authorization: "Bearer undefined" }, body: JSON.stringify({ userId: "user-a", generationId: fixture.id }) }));
    expect(denied.status).toBe(401);
    vi.stubGlobal("Netlify", { env: { get: () => "qa-cron-secret" } });
    expect((await background(new Request("https://site.example.invalid"))).status).toBe(405);
    expect((await background(new Request("https://site.example.invalid", { method: "POST", headers: { Authorization: "Bearer qa-cron-secret" }, body: JSON.stringify({ userId: {}, generationId: fixture.id }) }))).status).toBe(400);
    expect(mocks.getGeneration).not.toHaveBeenCalled();
  });

  it("reports an incomplete scheduled scan instead of a successful sweep", async () => {
    mocks.listPendingGenerationRefs.mockResolvedValue({ refs: [{ userId: "user-b", generationId: fixture.id }], scannedUsers: 3, scanComplete: false });
    mocks.fetch.mockResolvedValue(new Response(null, { status: 202 }));
    const log = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const result = await scheduled(new Request("https://site.example.invalid"), { site: { url: "https://site.example.invalid" } } as Parameters<typeof scheduled>[1]);
    expect(result.status).toBe(503);
    expect(await result.json()).toEqual({ scanComplete: false, scannedUsers: 3, found: 1, failedDispatches: 0 });
    expect(log).toHaveBeenCalledWith("reconcile-scheduled incomplete", { scanComplete: false, scannedUsers: 3, found: 1, failedDispatches: 0 });
    expect(mocks.fetch).toHaveBeenCalledWith(expect.any(URL), expect.objectContaining({ body: JSON.stringify({ userId: "user-b", generationId: fixture.id }) }));
  });
});
