import { describe, expect, it } from "vitest";
import { calculateSeedancePrice } from "./pricing";
import { MODEL_ID, SEEDANCE_20_MODEL_ID } from "./types";

describe("Seedance 2.5 pricing", () => {
  it("uses the no-video rate for text and image references", () => {
    expect(calculateSeedancePrice({ model: MODEL_ID, resolution: "720p", duration: 30, containsVideoInput: false })).toMatchObject({
      ratePerSecond: 1.436,
      total: 43.08,
      billableDuration: 30,
      billingUnits: 648000,
    });
  });

  it("adds the input and output durations when a video is supplied", () => {
    expect(calculateSeedancePrice({ model: MODEL_ID, resolution: "1080p", duration: 10, inputVideoDuration: 6, containsVideoInput: true })).toMatchObject({
      ratePerSecond: 1.53,
      inputVideoDuration: 6,
      billableDuration: 16,
      total: 24.48,
    });
  });

  it("calculates Seedance 2.0 4K video-input pricing", () => {
    expect(calculateSeedancePrice({ model: SEEDANCE_20_MODEL_ID, resolution: "4k", duration: 10, containsVideoInput: true })).toMatchObject({
      ratePerSecond: 2.955,
      total: 29.55,
    });
  });

  it("uses the selected output aspect ratio for billing units", () => {
    expect(calculateSeedancePrice({ model: MODEL_ID, resolution: "720p", ratio: "9:16", duration: 5, containsVideoInput: false })).toMatchObject({
      width: 720,
      height: 1280,
      fps: 24,
      billingUnits: 108000,
    });
  });
});
