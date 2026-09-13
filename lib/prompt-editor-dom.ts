import type { StudioAsset } from "./types";

export type PromptEditorReference = { asset: StudioAsset; label: string };
export type PromptEditorPart =
  | { type: "text"; text: string; start: number; end: number }
  | { type: "reference"; text: string; start: number; end: number; reference: PromptEditorReference };

// Match the complete number before looking it up: 图片1 must never consume 图片10.
export function promptEditorParts(value: string, references: PromptEditorReference[]): PromptEditorPart[] {
  const lookup = new Map(references.map((reference) => [reference.label, reference]));
  const parts: PromptEditorPart[] = [];
  let cursor = 0;
  for (const match of value.matchAll(/@((?:图片|视频|音频)\d+)(?!\d)/gu)) {
    const reference = lookup.get(match[1]);
    if (!reference) continue;
    const start = match.index;
    if (start > cursor) parts.push({ type: "text", text: value.slice(cursor, start), start: cursor, end: start });
    cursor = start + match[0].length;
    parts.push({ type: "reference", text: match[0], start, end: cursor, reference });
  }
  if (cursor < value.length) parts.push({ type: "text", text: value.slice(cursor), start: cursor, end: value.length });
  return parts;
}

export function atomicPromptRange(parts: PromptEditorPart[], start: number, end: number) {
  let selectionStart = start;
  let selectionEnd = end;
  for (const part of parts) {
    if (part.type !== "reference") continue;
    if (start > part.start && start < part.end) selectionStart = part.start;
    if (end > part.start && end < part.end) selectionEnd = part.end;
  }
  return { selectionStart, selectionEnd };
}

const isElement = (node: Node): node is HTMLElement => node.nodeType === 1;
const isBlock = (node: Node) => isElement(node) && /^(DIV|P|LI)$/.test(node.tagName);

export function promptNodeText(node: Node): string {
  if (node.nodeType === 3) return (node.textContent ?? "").replace(/\u00a0/g, " ");
  if (isElement(node)) {
    if (node.dataset.promptToken !== undefined) return node.dataset.promptToken;
    if (node.dataset.promptTrailing !== undefined) return "";
    if (node.tagName === "BR") return "\n";
  }
  const children = Array.from(node.childNodes);
  // Clearing a contenteditable leaves a browser-owned <br> for its empty caret.
  // Intentional newlines are text nodes, with a separately marked trailing BR.
  if (children.length === 1 && isElement(children[0]) && children[0].tagName === "BR") return "";
  return children.map((child, index) => {
    const text = promptNodeText(child);
    const previous = children[index - 1];
    const separator = previous && (isBlock(child) || isBlock(previous)) ? "\n" : "";
    // Browsers represent an empty editable paragraph as <div><br></div>.
    const emptyBlock = isBlock(child) && child.childNodes.length === 1 &&
      isElement(child.firstChild!) && child.firstChild!.tagName === "BR";
    return separator + (emptyBlock ? "" : text);
  }).join("");
}

type DomPoint = { node: Node; offset: number };

function childPosition(node: Node) {
  return Array.prototype.indexOf.call(node.parentNode!.childNodes, node) as number;
}

function pointOutsideToken(root: HTMLElement, node: Node, offset: number, end: boolean): DomPoint {
  const element = isElement(node) ? node : node.parentElement;
  const token = element?.closest<HTMLElement>("[data-prompt-token]");
  if (token && root.contains(token)) {
    return { node: token.parentNode!, offset: childPosition(token) + (end ? 1 : 0) };
  }
  return { node, offset };
}

function pointOffset(root: HTMLElement, point: DomPoint) {
  const prefix = root.ownerDocument.createRange();
  prefix.selectNodeContents(root);
  prefix.setEnd(point.node, point.offset);
  return promptNodeText(prefix.cloneContents()).length;
}

export function readPromptSelection(root: HTMLElement) {
  const value = promptNodeText(root);
  const selection = root.ownerDocument.getSelection();
  if (!selection?.rangeCount) return null;
  const range = selection.getRangeAt(0);
  if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) return null;
  const start = pointOutsideToken(root, range.startContainer, range.startOffset, false);
  const end = pointOutsideToken(root, range.endContainer, range.endOffset, !range.collapsed);
  return {
    value,
    selectionStart: Math.min(pointOffset(root, start), value.length),
    selectionEnd: Math.min(pointOffset(root, end), value.length),
  };
}

function offsetPoint(root: HTMLElement, offset: number, end: boolean): DomPoint {
  let remaining = Math.max(0, offset);
  function visit(parent: Node): DomPoint | null {
    const children = Array.from(parent.childNodes);
    for (let index = 0; index < children.length; index++) {
      const node = children[index];
      if (index > 0 && (isBlock(node) || isBlock(children[index - 1]))) {
        if (remaining === 0) return { node: parent, offset: index };
        remaining--;
      }
      const length = promptNodeText(node).length;
      if (node.nodeType === 3 && remaining <= length) return { node, offset: remaining };
      if (isElement(node) && (node.dataset.promptToken !== undefined || node.tagName === "BR")) {
        if (remaining === 0) return { node: parent, offset: index };
        if (remaining < length) return { node: parent, offset: index + (end ? 1 : 0) };
        if (remaining === length && length > 0) return { node: parent, offset: index + 1 };
      } else if (remaining <= length) {
        const found = visit(node);
        if (found) return found;
      }
      remaining -= length;
    }
    return null;
  }
  return visit(root) ?? { node: root, offset: root.childNodes.length };
}

export function setPromptSelection(root: HTMLElement, start: number, end: number) {
  const selection = root.ownerDocument.getSelection();
  if (!selection) return;
  const length = promptNodeText(root).length;
  const startPoint = offsetPoint(root, Math.min(start, length), false);
  const endPoint = offsetPoint(root, Math.min(end, length), start !== end);
  const range = root.ownerDocument.createRange();
  range.setStart(startPoint.node, startPoint.offset);
  range.setEnd(endPoint.node, endPoint.offset);
  selection.removeAllRanges();
  selection.addRange(range);
}

export function renderPromptEditor(root: HTMLElement, value: string, references: PromptEditorReference[]) {
  const document = root.ownerDocument;
  const fragment = document.createDocumentFragment();
  for (const part of promptEditorParts(value, references)) {
    if (part.type === "text") {
      fragment.append(document.createTextNode(part.text));
      continue;
    }
    const { asset, label } = part.reference;
    const chip = document.createElement("span");
    chip.className = "inline-reference";
    chip.contentEditable = "false";
    chip.dataset.promptToken = part.text;
    chip.dataset.assetId = asset.id;
    chip.dataset.sourceUrl = asset.sourceUrl;
    chip.setAttribute("aria-label", `@${label} · ${asset.name}`);
    chip.title = `@${label} · ${asset.name}`;
    const media = document.createElement("span");
    media.className = "inline-reference-media";
    media.setAttribute("aria-hidden", "true");
    if (asset.type === "image") {
      const image = document.createElement("img");
      image.src = asset.sourceUrl;
      image.alt = "";
      image.draggable = false;
      media.append(image);
    } else if (asset.type === "video") {
      const video = document.createElement("video");
      video.src = asset.sourceUrl;
      video.muted = true;
      video.playsInline = true;
      video.preload = "metadata";
      video.tabIndex = -1;
      media.append(video);
      const badge = document.createElement("span");
      badge.className = "inline-reference-play";
      badge.textContent = "▶";
      media.append(badge);
    } else {
      media.classList.add("inline-reference-audio");
      media.textContent = "♫";
      const audio = document.createElement("audio");
      audio.src = asset.sourceUrl;
      audio.preload = "none";
      audio.hidden = true;
      media.append(audio);
    }
    const caption = document.createElement("span");
    caption.className = "inline-reference-label";
    caption.textContent = `@${label}`;
    chip.append(media, caption);
    fragment.append(chip);
  }
  if (!value || value.endsWith("\n")) {
    const trailing = document.createElement("br");
    trailing.dataset.promptTrailing = "true";
    fragment.append(trailing);
  }
  root.replaceChildren(fragment);
}

export function promptEditorNeedsRender(root: HTMLElement, value: string, references: PromptEditorReference[]) {
  if (promptNodeText(root) !== value) return true;
  const expected = promptEditorParts(value, references).filter((part) => part.type === "reference");
  const rendered = Array.from(root.querySelectorAll<HTMLElement>("[data-prompt-token]"));
  return expected.length !== rendered.length || expected.some((part, index) => {
    const chip = rendered[index];
    return chip.dataset.promptToken !== part.text || chip.dataset.assetId !== part.reference.asset.id ||
      chip.dataset.sourceUrl !== part.reference.asset.sourceUrl ||
      chip.title !== `@${part.reference.label} · ${part.reference.asset.name}`;
  });
}
