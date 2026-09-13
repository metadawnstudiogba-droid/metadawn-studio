import { TemplateProvider, hasPurposeCredentials } from "./provider";
import { resolveProviderConfig } from "./provider-config";
import { getUserStorageConfig, mirrorRemoteVideo } from "./storage";
import { store } from "./store";

function archiveEndpoint() {
  const baseUrl = process.env.URL || process.env.BETTER_AUTH_URL;
  if (!baseUrl || !process.env.CRON_SECRET) throw new Error("归档服务尚未配置。");
  return new URL("/.netlify/functions/reconcile-background", baseUrl);
}

async function taskFor(userId: string, generationId: string) {
  const generation = await store.getGeneration(userId, generationId);
  if (!generation?.providerTaskId) throw new Error("任务不存在或缺少供应商任务 ID。");
  if (generation.status !== "WAITING_PROVIDER" && generation.status !== "ARCHIVING") return;
  const from = generation.status;
  const storageResult = await getUserStorageConfig(userId).catch(async () => {
    await store.markGenerationStorageError(userId, generationId, from, "R2 连接失效，请重新连接后重试归档。");
    return undefined;
  });
  if (!storageResult) return;
  const { config: storage } = storageResult;
  const providerConfig = await resolveProviderConfig(userId);
  if (!hasPurposeCredentials(providerConfig, "generation")) throw new Error("生成 API 凭证需要重新连接。");
  if ((generation.providerBindingId ?? `legacy:${userId}`) !== providerConfig.bindingId) throw new Error("任务属于其他供应商配置，不能用当前凭证查询。");
  const provider = new TemplateProvider(providerConfig, storage);
  return { generation, storage, task: await provider.getTask(generation.providerTaskId) };
}

async function archiveNow(userId: string, generationId: string) {
  const context = await taskFor(userId, generationId);
  if (!context) return store.getGeneration(userId, generationId);
  const { generation, storage, task } = context;
  if (generation.status !== "ARCHIVING") return generation;
  if (task.status === "FAILURE") return store.updateGeneration(userId, generationId, { status: "FAILURE", errorMessage: task.errorMessage, usage: task.usage });
  if (task.status !== "SUCCESS" || !task.videoUrl) return store.updateGeneration(userId, generationId, { status: "WAITING_PROVIDER", usage: task.usage });
  const claimed = await store.claimGenerationArchiveWorker(userId, generationId);
  if (!claimed) return store.getGeneration(userId, generationId);
  try {
    const savedVideoUrl = claimed.savedVideoUrl ?? await mirrorRemoteVideo(storage, task.videoUrl, claimed.id);
    return await store.updateGeneration(userId, generationId, { status: "READY", savedVideoUrl, usage: task.usage });
  } catch (error) {
    return store.updateGeneration(userId, generationId, { status: "STORAGE_ERROR", errorMessage: error instanceof Error ? error.message : "成品归档失败。", usage: task.usage });
  }
}

export async function dispatchArchive(userId: string, generationId: string) {
  const generation = await store.getGeneration(userId, generationId);
  if (!generation || generation.status !== "ARCHIVING") return;
  if (process.env.SITE_ID || process.env.NETLIFY) {
    const response = await fetch(archiveEndpoint(), {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.CRON_SECRET}`, "Content-Type": "application/json" },
      body: JSON.stringify({ userId, generationId }),
    });
    if (response.status !== 202) throw new Error("无法启动后台归档。");
    return;
  }
  await archiveNow(userId, generationId);
}

export async function pollAndDispatch(userId: string, generationId: string) {
  const generation = await store.getGeneration(userId, generationId);
  if (!generation || generation.status !== "WAITING_PROVIDER") return generation;
  const context = await taskFor(userId, generationId);
  if (!context) return store.getGeneration(userId, generationId);
  const { task } = context;
  if (task.status === "FAILURE") return store.updateGeneration(userId, generationId, { status: "FAILURE", errorMessage: task.errorMessage, usage: task.usage });
  if (task.status !== "SUCCESS" || !task.videoUrl) return store.updateGeneration(userId, generationId, { status: "WAITING_PROVIDER", usage: task.usage });
  const claimed = await store.claimGenerationArchiving(userId, generationId, "WAITING_PROVIDER");
  if (!claimed) return store.getGeneration(userId, generationId);
  try { await dispatchArchive(userId, generationId); }
  catch (error) { return store.updateGeneration(userId, generationId, { status: "STORAGE_ERROR", errorMessage: error instanceof Error ? error.message : "无法启动后台归档。" }); }
  return store.getGeneration(userId, generationId);
}

export async function retryStorageArchive(userId: string, generationId: string) {
  const generation = await store.getGeneration(userId, generationId);
  if (!generation || generation.status !== "STORAGE_ERROR") throw new Error("此任务当前不能重新归档。");
  await getUserStorageConfig(userId);
  const claimed = await store.claimGenerationArchiving(userId, generationId, "STORAGE_ERROR");
  if (!claimed) throw new Error("此任务当前不能重新归档。");
  try { await dispatchArchive(userId, generationId); }
  catch (error) { await store.updateGeneration(userId, generationId, { status: "STORAGE_ERROR", errorMessage: error instanceof Error ? error.message : "无法启动后台归档。" }); throw error; }
  return claimed;
}

export async function reconcileInBackground(userId: string, generationId: string) {
  const generation = await store.getGeneration(userId, generationId);
  if (!generation || (generation.status !== "WAITING_PROVIDER" && generation.status !== "ARCHIVING")) return generation;
  if (generation.status === "WAITING_PROVIDER") {
    const context = await taskFor(userId, generationId);
    if (!context) return store.getGeneration(userId, generationId);
    const { task } = context;
    if (task.status === "FAILURE") return store.updateGeneration(userId, generationId, { status: "FAILURE", errorMessage: task.errorMessage, usage: task.usage });
    if (task.status !== "SUCCESS" || !task.videoUrl) return store.updateGeneration(userId, generationId, { status: "WAITING_PROVIDER", usage: task.usage });
    if (!await store.claimGenerationArchiving(userId, generationId, "WAITING_PROVIDER")) return store.getGeneration(userId, generationId);
  }
  return archiveNow(userId, generationId);
}
