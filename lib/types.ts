export const MODEL_ID = "doubao-seedance-2-5-260628";
export const SEEDANCE_20_MODEL_ID = "doubao-seedance-2-0-260128";

export const SEEDANCE_MODELS = [
  { id: MODEL_ID, label: "Seedance 2.5", enabled: true, description: "支持多模态参考、精准编辑与超长生成" },
  { id: SEEDANCE_20_MODEL_ID, label: "Seedance 2.0", enabled: true, description: "标准推理通道" },
] as const;

export type AssetType = "image" | "video" | "audio";
export type AssetRole =
  | "identity"
  | "scene"
  | "style"
  | "motion"
  | "camera"
  | "sound"
  | "first_frame"
  | "last_frame"
  | "source_video"
  | "green_screen_subject"
  | "background"
  | "white_model";

export type StudioMode = "generate" | "extend" | "edit" | "green_screen" | "white_model";
export type TaskStatus =
  | "WAITING_PROVIDER"
  | "ARCHIVING"
  | "STORAGE_ERROR"
  | "READY"
  | "FAILURE";

export type ProviderTaskStatus = "WAITING" | "SUCCESS" | "FAILURE";

export interface StudioAsset {
  id: string;
  name: string;
  type: AssetType;
  purpose: string;
  sourceUrl: string;
  providerAssetId?: string;
  providerBindingId?: string;
  registrationStartedAt?: string;
  providerStatus: "unregistered" | "processing" | "ready" | "failed" | "temporary";
  createdAt: string;
}

export interface ReferenceInput {
  assetId: string;
  role: AssetRole;
}

export interface GenerationInput {
  model?: string;
  mode: StudioMode;
  prompt: string;
  ratio: "16:9" | "9:16" | "1:1" | "adaptive";
  duration: number;
  resolution: "480p" | "720p" | "1080p" | "4k";
  generateAudio: boolean;
  references: ReferenceInput[];
  parentGenerationId?: string;
  editRange?: { start: number; end: number };
}

export interface GenerationRecord {
  id: string;
  providerTaskId?: string;
  providerBindingId?: string;
  providerSnapshot?: { id: string; name: string; version: string };
  mode: StudioMode;
  model: string;
  prompt: string;
  input: GenerationInput;
  status: TaskStatus;
  parentGenerationId?: string;
  providerVideoUrl?: string;
  savedVideoUrl?: string;
  errorMessage?: string;
  usage?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface ProviderTask {
  id: string;
  status: ProviderTaskStatus;
  videoUrl?: string;
  errorMessage?: string;
  usage?: Record<string, unknown>;
}
