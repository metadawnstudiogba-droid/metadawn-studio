import { MODEL_ID, type AssetRole, type GenerationInput, type ProviderTask, type ProviderTaskStatus, type StudioAsset } from "./types";
import { resolveProviderUrl } from "./storage";
import { providerPrompt } from "./prompt-mentions";
import type { R2Config } from "./storage";

function normaliseStatus(status: string | undefined): ProviderTaskStatus {
  const value = (status ?? "UNKNOWN").toUpperCase();
  const lookup: Record<string, ProviderTaskStatus> = {
    QUEUED: "WAITING", RUNNING: "WAITING", IN_PROGRESS: "WAITING", SUBMITTED: "WAITING",
    SUCCEEDED: "SUCCESS", SUCCESS: "SUCCESS", FAILED: "FAILURE", FAILURE: "FAILURE", EXPIRED: "FAILURE",
  };
  return lookup[value] ?? "WAITING";
}

export function normaliseAssetStatus(status: string | undefined): StudioAsset["providerStatus"] {
  const value = (status ?? "").trim().toUpperCase();
  if (["READY", "SUCCESS", "SUCCEEDED", "COMPLETED"].includes(value)) return "ready";
  if (["FAILED", "FAILURE", "REJECTED", "EXPIRED"].includes(value)) return "failed";
  return "processing";
}

function contentType(asset: StudioAsset): "image_url" | "video_url" | "audio_url" {
  return asset.type === "image" ? "image_url" : asset.type === "video" ? "video_url" : "audio_url";
}

function providerRole(role: AssetRole, type: StudioAsset["type"], hasLastFrame: boolean) {
  const roles: Partial<Record<AssetRole, string>> = {
    last_frame: "last_frame", source_video: "reference_video",
    green_screen_subject: "reference_video", background: "reference_image", white_model: "reference_video",
  };
  if (role === "first_frame") return hasLastFrame ? "first_frame" : "reference_image";
  if (role === "background") return type === "video" ? "reference_video" : "reference_image";
  return roles[role] ?? (type === "video" ? "reference_video" : type === "audio" ? "reference_audio" : "reference_image");
}

async function providerAssetUrl(asset: StudioAsset, r2?: R2Config) {
  return asset.providerStatus === "ready" && asset.providerAssetId
    ? `asset://${asset.providerAssetId.replace(/^asset:\/\//, "")}`
    : r2 ? resolveProviderUrl(r2, asset.sourceUrl) : asset.sourceUrl;
}

export class KkidcSeedanceProvider {
  private readonly token: string;
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly r2?: R2Config;

  constructor(config: { KKIDC_API_TOKEN?: string; KKIDC_API_BASE?: string; KKIDC_SEEDANCE_MODEL?: string; r2?: R2Config } = {}) {
    this.token = config.KKIDC_API_TOKEN ?? "";
    this.baseUrl = config.KKIDC_API_BASE ?? "https://ai-api.kkidc.com";
    this.model = config.KKIDC_SEEDANCE_MODEL ?? MODEL_ID;
    this.r2 = config.r2;
  }

  private async request(path: string, init?: RequestInit) {
    if (!this.token) throw new Error("KKIDC_API_TOKEN 未配置。");
    const response = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json", ...init?.headers },
      cache: "no-store",
      signal: init?.signal ?? AbortSignal.timeout(60_000),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data?.error?.message ?? data?.message ?? `KKIDC 请求失败（${response.status}）。`);
    if (data?.success === false) throw new Error(data?.message || "KKIDC 请求失败。");
    return data;
  }

  async registerAsset(asset: StudioAsset) {
    const url = this.r2 ? await resolveProviderUrl(this.r2, asset.sourceUrl) : asset.sourceUrl;
    const data = await this.request("/v1/assets/upload", {
      method: "POST", body: JSON.stringify({ url, type: asset.type, purpose: asset.purpose }),
    });
    const assetId = data?.data?.asset_id as string | undefined;
    if (!assetId) throw new Error("KKIDC 素材库未返回 asset_id。");
    return { assetId, status: normaliseAssetStatus(data?.data?.status ?? data?.status) };
  }

  async createGeneration(input: GenerationInput, assets: Map<string, StudioAsset>) {
    const prompt = providerPrompt(input.prompt, input.references, assets);
    const hasLastFrame = input.references.some((reference) => reference.role === "last_frame");
    const content: Array<Record<string, unknown>> = await Promise.all(input.references.map(async (reference) => {
      const asset = assets.get(reference.assetId);
      if (!asset) throw new Error("引用素材不存在。");
      const type = contentType(asset);
      return { type, [type]: { url: await providerAssetUrl(asset, this.r2) }, role: providerRole(reference.role, asset.type, hasLastFrame) };
    }));
    content.push({ type: "text", text: prompt });
    const body = {
      model: input.model ?? this.model,
      prompt,
      content,
      generate_audio: input.generateAudio,
      ratio: input.ratio,
      duration: input.duration,
      resolution: input.resolution,
      watermark: false,
      // Provider compatibility probe: KKIDC will reject unknown advanced fields rather than silently use another model.
      ...(input.editRange ? { edit_range: input.editRange } : {}),
    };
    const data = await this.request("/sd/api/v3/contents/generations/tasks", { method: "POST", body: JSON.stringify(body) });
    if (!data?.id) throw new Error("KKIDC 未返回任务 ID。");
    return { id: data.id as string, request: body };
  }

  async getTask(taskId: string): Promise<ProviderTask> {
    const data = await this.request(`/sd/api/v3/contents/generations/tasks/${encodeURIComponent(taskId)}`);
    const status = normaliseStatus(data?.status ?? data?.data?.status);
    return {
      id: data?.id ?? taskId,
      status,
      videoUrl: data?.content?.video_url ?? data?.data?.content?.video_url,
      errorMessage: data?.error?.message ?? data?.fail_reason ?? data?.message,
      usage: data?.usage ?? data?.data?.usage,
    };
  }

  async getAssetStatus(providerAssetId: string) {
    const data = await this.request(`/v1/assets/${encodeURIComponent(providerAssetId)}`);
    return normaliseAssetStatus(data?.data?.status ?? data?.status);
  }

}
