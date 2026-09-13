import { describe, expect, it } from "vitest";
import { atomicPromptRange, promptEditorParts, promptNodeText, type PromptEditorReference } from "./prompt-editor-dom";
import type { StudioAsset } from "./types";

const image: StudioAsset = { id: "a", name: "风灵", type: "image", purpose: "主体", sourceUrl: "/image.jpg", providerStatus: "temporary", createdAt: "2026-09-08" };
const references: PromptEditorReference[] = [
  { asset: image, label: "图片1" },
  { asset: { ...image, id: "b", name: "小雅" }, label: "图片2" },
  { asset: { ...image, id: "v", type: "video" }, label: "视频1" },
];

describe("inline reference editor", () => {
  it("preserves canonical text, newlines, and repeated references", () => {
    const value = "@图片1 看向 @图片2\n跟随 @视频1，@图片1 转身。";
    const parts = promptEditorParts(value, references);
    expect(parts.map((part) => part.text).join("")).toBe(value);
    expect(parts.filter((part) => part.type === "reference").map((part) => part.reference.asset.id)).toEqual(["a", "b", "v", "a"]);
    for (const part of parts) expect(value.slice(part.start, part.end)).toBe(part.text);
  });

  it("does not turn missing references, similar names, or longer numbers into an existing chip", () => {
    const value = "@图片10 @风灵 @音频1 @图片2";
    const parts = promptEditorParts(value, references);
    expect(parts.filter((part) => part.type === "reference").map((part) => part.text)).toEqual(["@图片2"]);
    expect(parts.map((part) => part.text).join("")).toBe(value);
  });

  it("expands partial chip selections to whole canonical references", () => {
    const parts = promptEditorParts("先 @图片1 然后 @图片2", references);
    expect(atomicPromptRange(parts, 4, 12)).toEqual({ selectionStart: 2, selectionEnd: 14 });
    expect(atomicPromptRange(parts, 0, 1)).toEqual({ selectionStart: 0, selectionEnd: 1 });
    expect(atomicPromptRange(parts, 6, 6)).toEqual({ selectionStart: 6, selectionEnd: 6 });
  });

  it("does not submit the browser's empty-editor caret placeholder as a newline", () => {
    const element = (tagName: string, childNodes: Node[] = [], dataset = {}) => ({
      nodeType: 1, tagName, childNodes, firstChild: childNodes[0] ?? null, dataset,
    }) as unknown as Node;
    const text = (textContent: string) => ({ nodeType: 3, textContent }) as Node;
    expect(promptNodeText(element("DIV", [element("BR")]))).toBe("");
    expect(promptNodeText(element("DIV", [text("\n"), element("BR", [], { promptTrailing: "true" })]))).toBe("\n");
    expect(promptNodeText(element("DIV", [text("主角是@")]))).toBe("主角是@");
  });
});
