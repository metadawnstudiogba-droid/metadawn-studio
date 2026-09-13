import { SEEDANCE_20_MODEL_ID, SEEDANCE_MODELS, type AssetType, type GenerationInput, type ReferenceInput, type StudioMode } from "./types";
import { capabilitiesFor, type ProviderTemplate } from "./provider-template";

const LIMITS: Record<AssetType, number> = { image: 30, video: 10, audio: 10 };

export function validateReferences(
  references: ReferenceInput[],
  assetTypes: Map<string, AssetType>,
  mode: StudioMode,
  limits = LIMITS,
) {
  const counts: Record<AssetType, number> = { image: 0, video: 0, audio: 0 };
  const roles = new Set(references.map((reference) => reference.role));

  for (const reference of references) {
    const type = assetTypes.get(reference.assetId);
    if (!type) throw new Error("所选素材不存在或已被删除。");
    counts[type] += 1;
  }
  for (const [type, count] of Object.entries(counts) as [AssetType, number][]) {
    if (count > limits[type]) throw new Error(`${type} 素材最多可使用 ${limits[type]} 个。`);
  }

  const mustHave: Partial<Record<StudioMode, string[]>> = {
    extend: ["source_video"],
    edit: ["source_video"],
    green_screen: ["green_screen_subject", "background"],
    white_model: ["white_model"],
  };
  for (const role of mustHave[mode] ?? []) {
    if (!roles.has(role as ReferenceInput["role"])) throw new Error(`此模式必须选择“${role}”素材。`);
  }
  if (roles.has("last_frame") && !roles.has("first_frame")) throw new Error("尾帧参考必须同时选择首帧素材。");
  const requiredTypes: Partial<Record<ReferenceInput["role"], AssetType[]>> = {
    first_frame: ["image"], last_frame: ["image"], source_video: ["video"],
    green_screen_subject: ["video"], white_model: ["video"], background: ["image", "video"],
  };
  for (const reference of references) {
    const expected = requiredTypes[reference.role];
    const actual = assetTypes.get(reference.assetId);
    if (expected && actual && !expected.includes(actual)) throw new Error(`“${reference.role}”必须使用 ${expected.join(" 或 ")} 素材。`);
  }
}

export function validateGeneration(input: GenerationInput, assetTypes: Map<string, AssetType>, template?: ProviderTemplate) {
  if (typeof input.prompt !== "string" || !input.prompt.trim()) throw new Error("请输入创作提示词。");
  if (input.prompt.length > 16000) throw new Error("提示词最多 16000 个字符。");
  if (!["generate", "extend", "edit", "green_screen", "white_model"].includes(input.mode)) throw new Error("生成模式无效。");
  if (!Array.isArray(input.references) || input.references.length > 50 || input.references.some(ref => !ref || typeof ref.assetId !== "string" || !["identity", "scene", "style", "motion", "camera", "sound", "first_frame", "last_frame", "source_video", "green_screen_subject", "background", "white_model"].includes(ref.role))) throw new Error("参考素材格式无效。");
  if (input.model && !(template?.models ?? SEEDANCE_MODELS).some(model => model.id === input.model)) throw new Error("所选 Seedance 模型不受支持。");
  if (!template && input.resolution === "4k" && input.model !== SEEDANCE_20_MODEL_ID) throw new Error("4K 目前仅适用于 Seedance 2.0。");
  const caps = template ? capabilitiesFor(template, input.model ?? template.models[0].id) : undefined;
  if (caps && (!caps.modes.includes(input.mode) || !caps.resolutions.includes(input.resolution) || !caps.ratios.includes(input.ratio))) throw new Error("此供应商模型不支持所选模式、分辨率或比例。");
  const maxDuration = input.mode === "extend" ? caps?.maxExtendDuration ?? 180 : caps?.maxDuration ?? 30;
  const minDuration = caps?.minDuration ?? 4;
  if (!Number.isInteger(input.duration) || input.duration < minDuration || input.duration > maxDuration) throw new Error(`${input.mode === "extend" ? "超长视频" : "单次生成"}时长必须为 ${minDuration}–${maxDuration} 秒。`);
  if ((caps?.audio ?? "required") === "required" && !input.generateAudio) throw new Error("视频生成必须包含音频。");
  if (caps?.audio === "unsupported" && input.generateAudio) throw new Error("此供应商模型不支持生成音频。");
  if (input.mode === "edit") {
    if (!input.editRange || !Number.isFinite(input.editRange.start) || !Number.isFinite(input.editRange.end) || input.editRange.start < 0 || input.editRange.end <= input.editRange.start) {
      throw new Error("精准编辑需要有效的起止时间戳。");
    }
  }
  validateReferences(input.references, assetTypes, input.mode, caps?.references);
}
