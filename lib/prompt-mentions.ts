import type { ReferenceInput, StudioAsset } from "./types";

export type PromptMention = { start: number; end: number; query: string };

export function findPromptMention(value: string, start: number, end = start): PromptMention | null {
  if (start !== end) return null;
  const match = /[@＠]([^@＠\s，。！？；：、,!?;:()[\]{}【】（）]*)$/u.exec(value.slice(0, start));
  return match ? { start: match.index, end: start, query: match[1] } : null;
}

export function insertPromptMention(value: string, token: string, range: { start: number; end: number }) {
  const insertion = `@${token} `;
  return {
    value: value.slice(0, range.start) + insertion + value.slice(range.end),
    caret: range.start + insertion.length,
  };
}

export function referenceLabels(references: ReferenceInput[], assets: Map<string, StudioAsset>) {
  const counts = { image: 0, video: 0, audio: 0 };
  const types = { image: "图片", video: "视频", audio: "音频" };
  const labels = new Map<string, string>();
  for (const reference of references) {
    const asset = assets.get(reference.assetId);
    if (asset) labels.set(asset.id, `${types[asset.type]}${++counts[asset.type]}`);
  }
  return labels;
}

// Replace in one pass so renumbering never changes a token twice.
export function remapPromptMentions(value: string, previous: ReferenceInput[], next: ReferenceInput[], assets: Map<string, StudioAsset>) {
  const nextLabels = referenceLabels(next, assets);
  const replacements = new Map([...referenceLabels(previous, assets)].map(([id, label]) => [
    label, nextLabels.has(id) ? `@${nextLabels.get(id)}` : assets.get(id)!.name,
  ]));
  return value.replace(/[@＠]((?:图片|视频|音频)\d+)(?!\d)/gu, (token, label: string) => replacements.get(label) ?? token);
}

export function providerPrompt(value: string, references: ReferenceInput[], assets: Map<string, StudioAsset>) {
  const labels = new Set(referenceLabels(references, assets).values());
  return value.replace(/[@＠]((?:图片|视频|音频)\d+)(?!\d)/gu, (token, label: string) => labels.has(label) ? label : token);
}
