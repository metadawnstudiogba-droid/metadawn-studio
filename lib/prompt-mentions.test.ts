import { describe, expect, it } from "vitest";
import { findPromptMention, insertPromptMention, referenceLabels, remapPromptMentions } from "./prompt-mentions";
import type { ReferenceInput, StudioAsset } from "./types";

const assets = new Map<string, StudioAsset>([
  ["a", { id: "a", name: "风灵", type: "image", purpose: "人物", sourceUrl: "", providerStatus: "temporary", createdAt: "" }],
  ["b", { id: "b", name: "小雅", type: "image", purpose: "人物", sourceUrl: "", providerStatus: "ready", createdAt: "" }],
  ["v", { id: "v", name: "动作", type: "video", purpose: "", sourceUrl: "", providerStatus: "temporary", createdAt: "" }],
]);
const references: ReferenceInput[] = [{ assetId: "a", role: "identity" }, { assetId: "v", role: "motion" }, { assetId: "b", role: "identity" }];

describe("prompt reference mentions", () => {
  it("finds an @ query at the caret inside Chinese prose", () => {
    expect(findPromptMention("主体是@风，保持身份", 5)).toEqual({ start: 3, end: 5, query: "风" });
    expect(findPromptMention("主体是＠", 4)).toEqual({ start: 3, end: 4, query: "" });
    expect(findPromptMention("主体是@风，", 6)).toBeNull();
    expect(findPromptMention("@风", 0, 2)).toBeNull();
  });

  it("replaces the active query without losing surrounding prose", () => {
    expect(insertPromptMention("车内@风回头", "图片1", { start: 2, end: 4 })).toEqual({ value: "车内@图片1 回头", caret: 7 });
  });

  it("inserts at the saved toolbar caret or replaces a selection", () => {
    expect(insertPromptMention("先回头", "图片1", { start: 1, end: 1 }).value).toBe("先@图片1 回头");
    expect(insertPromptMention("风灵回头", "图片1", { start: 0, end: 2 }).value).toBe("@图片1 回头");
  });

  it("numbers temporary and library references by media type and attachment order", () => {
    expect([...referenceLabels(references, assets)]).toEqual([["a", "图片1"], ["v", "视频1"], ["b", "图片2"]]);
  });

  it("keeps identity when an earlier reference is removed", () => {
    expect(remapPromptMentions("@图片1 看向@图片2 ，动作参考@视频1", references, references.slice(1), assets))
      .toBe("风灵 看向@图片1 ，动作参考@视频1");
  });

  it("renumbers in one pass and leaves unrelated mentions untouched", () => {
    expect(remapPromptMentions("@图片1 @图片2 @风灵 @图片20", references, [references[2], references[1], references[0]], assets))
      .toBe("@图片2 @图片1 @风灵 @图片20");
  });
});
