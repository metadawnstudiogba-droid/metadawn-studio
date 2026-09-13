import { MODEL_ID, SEEDANCE_20_MODEL_ID, type GenerationInput } from "./types";

type Resolution = GenerationInput["resolution"];

type Rate = { withoutVideo: number; withVideo: number };
type Ratio = GenerationInput["ratio"];

export const SEEDANCE_ESTIMATE_FPS = 24;

const LANDSCAPE_DIMENSIONS: Record<Resolution, { width: number; height: number }> = {
  "480p": { width: 854, height: 480 },
  "720p": { width: 1280, height: 720 },
  "1080p": { width: 1920, height: 1080 },
  "4k": { width: 3840, height: 2160 },
};

export function estimateOutputDimensions(resolution: Resolution, ratio: Ratio = "16:9") {
  const landscape = LANDSCAPE_DIMENSIONS[resolution];
  if (ratio === "9:16") return { width: landscape.height, height: landscape.width };
  if (ratio === "1:1") return { width: landscape.height, height: landscape.height };
  return landscape;
}

export const SEEDANCE_RATES: Record<string, Partial<Record<Resolution, Rate>>> = {
  [MODEL_ID]: {
    "480p": { withoutVideo: 0.638, withVideo: 0.383 },
    "720p": { withoutVideo: 1.436, withVideo: 0.862 },
    "1080p": { withoutVideo: 2.56, withVideo: 1.53 },
  },
  [SEEDANCE_20_MODEL_ID]: {
    "480p": { withoutVideo: 0.42, withVideo: 0.255 },
    "720p": { withoutVideo: 0.944, withVideo: 0.575 },
    "1080p": { withoutVideo: 2.355, withVideo: 1.431 },
    "4k": { withoutVideo: 4.802, withVideo: 2.955 },
  },
};

export function calculateSeedancePrice(input: {
  model: string;
  resolution: Resolution;
  duration: number;
  containsVideoInput: boolean;
  inputVideoDuration?: number;
  ratio?: Ratio;
  fps?: number;
  quantity?: number;
}) {
  const rates = SEEDANCE_RATES[input.model]?.[input.resolution];
  if (!rates) throw new Error("所选模型与分辨率暂无计费规则。");
  const ratePerSecond = input.containsVideoInput ? rates.withVideo : rates.withoutVideo;
  const inputVideoDuration = input.containsVideoInput ? Math.max(0, input.inputVideoDuration ?? 0) : 0;
  const billableDuration = input.duration + inputVideoDuration;
  const dimensions = estimateOutputDimensions(input.resolution, input.ratio);
  const fps = input.fps ?? SEEDANCE_ESTIMATE_FPS;
  const quantity = input.quantity ?? 1;
  return {
    ratePerSecond,
    inputVideoDuration,
    outputVideoDuration: input.duration,
    billableDuration,
    width: dimensions.width,
    height: dimensions.height,
    fps,
    billingUnits: billableDuration * dimensions.width * dimensions.height * fps / 1024 * quantity,
    total: ratePerSecond * billableDuration * quantity,
  };
}
