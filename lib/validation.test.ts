import { describe, expect, it } from "vitest";
import { validateGeneration } from "./validation";
import { MODEL_ID, type GenerationInput } from "./types";

const base: GenerationInput = { mode: "generate", prompt: "A calm studio shot", ratio: "16:9", duration: 30, resolution: "720p", generateAudio: true, references: [] };

describe("generation validation", () => {
  it("accepts a 30-second generation", () => expect(() => validateGeneration(base, new Map())).not.toThrow());
  it("accepts a 180-second extended video", () => {
    const input = { ...base, mode: "extend" as const, duration: 180, references: [{ assetId: "source", role: "source_video" as const }] };
    expect(() => validateGeneration(input, new Map([["source", "video" as const]]))).not.toThrow();
  });
  it("keeps ordinary generation capped at 30 seconds", () => expect(() => validateGeneration({ ...base, duration: 31 }, new Map())).toThrow("4–30"));
  it("requires generated audio", () => expect(() => validateGeneration({ ...base, generateAudio: false }, new Map())).toThrow("音频"));
  it("rejects an unknown model id", () => expect(() => validateGeneration({ ...base, model: "unknown-model" }, new Map())).toThrow("模型"));
  it("accepts the Seedance 2.0 model id", () => expect(() => validateGeneration({ ...base, model: "doubao-seedance-2-0-260128" }, new Map())).not.toThrow());
  it("accepts 4K for Seedance 2.0", () => expect(() => validateGeneration({ ...base, model: "doubao-seedance-2-0-260128", resolution: "4k" }, new Map())).not.toThrow());
  it("rejects 4K for Seedance 2.5", () => expect(() => validateGeneration({ ...base, model: MODEL_ID, resolution: "4k" }, new Map())).toThrow("4K"));
  it("caps image references at 30", () => {
    const references = Array.from({ length: 31 }, (_, index) => ({ assetId: `image-${index}`, role: "identity" as const }));
    const types = new Map(references.map((reference) => [reference.assetId, "image" as const]));
    expect(() => validateGeneration({ ...base, references }, types)).toThrow("最多");
  });
  it("requires source video for edit", () => expect(() => validateGeneration({ ...base, mode: "edit", editRange: { start: 2, end: 5 } }, new Map())).toThrow("source_video"));
  it("rejects invalid edit timing", () => expect(() => validateGeneration({ ...base, mode: "edit", editRange: { start: 5, end: 5 } }, new Map())).toThrow("时间戳"));
  it("requires a video as the green-screen subject", () => {
    const input = { ...base, mode: "green_screen" as const, references: [{ assetId: "a", role: "green_screen_subject" as const }, { assetId: "b", role: "background" as const }] };
    expect(() => validateGeneration(input, new Map([["a", "image" as const], ["b", "image" as const]]))).toThrow("green_screen_subject");
  });
  it("requires a first frame when a last frame is selected", () => {
    const input = { ...base, references: [{ assetId: "last", role: "last_frame" as const }] };
    expect(() => validateGeneration(input, new Map([["last", "image" as const]]))).toThrow("首帧");
  });
});
