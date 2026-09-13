import { describe, expect, it } from "vitest";
import { BUILTIN_TEMPLATES, DEFAULT_TEMPLATE } from "./builtin-templates";
import { evaluateTemplate, sameJsonValue, validateProviderTemplate, type ProviderTemplate, type TemplateValue } from "./provider-template";
import { validateGeneration } from "./validation";
import type { GenerationInput } from "./types";

describe("declarative provider templates", () => {
  it("compares JSON objects independent of key order while preserving array order", () => {
    expect(sameJsonValue({ b: { y: 2, x: 1 }, a: ["first", "second"] }, { a: ["first", "second"], b: { x: 1, y: 2 } })).toBe(true);
    expect(sameJsonValue({ a: ["first", "second"] }, { a: ["second", "first"] })).toBe(false);
    expect(sameJsonValue({ a: 1, omitted: undefined }, { a: 1 })).toBe(true);
  });

  it("accepts both bundled adapters and maps a different provider's payload without code", () => {
    for (const template of BUILTIN_TEMPLATES) expect(validateProviderTemplate(template).schemaVersion).toBe(1);
    const result = evaluateTemplate({ engine: { $ref: "input.model" }, text: { $string: "Scene: {{input.prompt}}" }, images: { $map: "references", value: { href: { $ref: "item.url" }, kind: { $lookup: { $ref: "item.type" }, values: { image: "still" }, default: "clip" } } }, missing: { $ref: "secrets.key" } }, { input: { model: "custom", prompt: "A tree" }, references: [{ type: "image", url: "https://example.com/a.png" }] });
    expect(result).toEqual({ engine: "custom", text: "Scene: A tree", images: [{ href: "https://example.com/a.png", kind: "still" }] });
  });

  it.each([
    (t: ProviderTemplate) => { (t as unknown as Record<string, unknown>).script = "process.env"; },
    (t: ProviderTemplate) => { t.operations.createGeneration.body = { $eval: "fetch('http://localhost')" }; },
    (t: ProviderTemplate) => { t.operations.createGeneration.auth = { type: "bearer", credential: "assetToken" }; },
    (t: ProviderTemplate) => { t.operations.createGeneration.path = "//private.invalid/"; },
    (t: ProviderTemplate) => { t.operations.createGeneration.path = "/../../private"; },
    (t: ProviderTemplate) => { t.operations.createGeneration.body = { $ref: "input.__proto__.key" }; },
    (t: ProviderTemplate) => { t.operations.createGeneration.auth = { type: "header", credential: "generationToken", name: "Host" }; },
    (t: ProviderTemplate) => { t.capabilities.minDuration = 100; },
    (t: ProviderTemplate) => { delete t.operations.getAsset; },
    (t: ProviderTemplate) => { t.endpoints.generation!.defaultUrl = "https://example.com/?token=secret"; },
  ])("rejects unsafe or incomplete template #%#", mutate => {
    const template = structuredClone(DEFAULT_TEMPLATE); mutate(template);
    expect(() => validateProviderTemplate(template)).toThrow();
  });

  it("bounds nested mapping work", () => {
    let expression: TemplateValue = { $ref: "item" };
    for (let i = 0; i < 6; i++) expression = { $map: "references", value: expression };
    expect(() => evaluateTemplate(expression, { references: Array.from({ length: 10 }, (_, i) => i) })).toThrow("复杂度");
  });

  it("enforces the selected provider's capabilities before submission", () => {
    const ark = BUILTIN_TEMPLATES[1];
    const input: GenerationInput = { model: ark.models[0].id, mode: "generate", prompt: "A tree", ratio: "16:9", resolution: "720p", duration: 10, generateAudio: true, references: [] };
    expect(() => validateGeneration(input, new Map(), ark)).not.toThrow();
    expect(() => validateGeneration({ ...input, mode: "edit" }, new Map(), ark)).toThrow("不支持");
    expect(() => validateGeneration({ ...input, duration: 30 }, new Map(), ark)).toThrow("时长");
    expect(() => validateGeneration({ ...input, duration: NaN }, new Map(), ark)).toThrow();
    const refs = Array.from({ length: 10 }, (_, i) => ({ assetId: String(i), role: "scene" as const }));
    expect(() => validateGeneration({ ...input, references: refs }, new Map(refs.map(ref => [ref.assetId, "image" as const])), ark)).toThrow("9");
  });
});
