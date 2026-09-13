"use client";

import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { calculateSeedancePrice } from "@/lib/pricing";
import { findPromptMention, insertPromptMention, referenceLabels, remapPromptMentions, type PromptMention } from "@/lib/prompt-mentions";
import { PromptEditor, type PromptEditorHandle, type PromptEditorSelection } from "./prompt-editor";
import { authClient } from "@/lib/auth-client";
import { MODEL_ID, type AssetRole, type GenerationInput, type GenerationRecord, type StudioAsset, type StudioMode } from "@/lib/types";

import { ProviderSettingsForm } from "./provider-settings";
import { DEFAULT_TEMPLATE } from "@/lib/builtin-templates";
import { capabilitiesFor, type ProviderSettingsStatus } from "@/lib/provider-template";

type Panel = "creation" | "model" | "workflow" | "format" | "duration" | "mention" | "assets" | "settings" | null;
type StorageStatus = { configured: boolean; provider: string; bucket?: string; accountId?: string; jurisdiction?: "default" | "eu" | "us" | "fedramp"; accessKeyHint?: string; private: boolean; state: "disconnected" | "needs_cors" | "connected" | "needs_reconnect" | "degraded"; error?: string };

const modeCopy: Record<StudioMode, { label: string; short: string; hint: string; icon: string }> = {
  generate: { label: "全能参考", short: "全能参考", hint: "自由组合图片、视频与音频参考", icon: "✣" },
  extend: { label: "超长视频", short: "超长视频", hint: "从已完成片段继续生成连贯内容", icon: "↝" },
  edit: { label: "智能编辑", short: "智能编辑", hint: "按时间范围精准修改局部画面", icon: "◫" },
  green_screen: { label: "绿幕编辑", short: "绿幕", hint: "将绿幕主体合成到新背景", icon: "◩" },
  white_model: { label: "白模参考", short: "白模", hint: "继承白模的动作、机位与调度", icon: "⌁" },
};

const roles: { value: AssetRole; label: string }[] = [
  { value: "identity", label: "主体身份" }, { value: "scene", label: "场景" }, { value: "style", label: "风格" },
  { value: "motion", label: "动作" }, { value: "camera", label: "镜头" }, { value: "sound", label: "声音" },
  { value: "first_frame", label: "首帧" }, { value: "last_frame", label: "尾帧" },
  { value: "source_video", label: "源视频" }, { value: "green_screen_subject", label: "绿幕主体" },
  { value: "background", label: "背景" }, { value: "white_model", label: "白模视频" },
];

const formatStatus = (status: string) => ({ WAITING_PROVIDER: "生成中", ARCHIVING: "正在保存", STORAGE_ERROR: "存储需重连", READY: "已完成", FAILURE: "失败" } as Record<string, string>)[status] ?? status;

function AssetVisual({ asset, large = false, controls = false }: { asset: StudioAsset; large?: boolean; controls?: boolean }) {
  if (asset.type === "image") return <img src={asset.sourceUrl} alt={asset.name} />;
  if (asset.type === "video") return <video src={asset.sourceUrl} muted={!controls} controls={controls} autoPlay={large} loop={large && !controls} playsInline preload="metadata" />;
  return <span className="audio-visual">♫<small>{asset.name}</small></span>;
}

function readVideoDuration(source: string | File) {
  return new Promise<number>((resolve, reject) => {
    const video = document.createElement("video");
    const objectUrl = source instanceof File ? URL.createObjectURL(source) : null;
    const url = typeof source === "string" ? source : objectUrl!;
    let settled = false;
    const timeout = window.setTimeout(() => finish(new Error("读取视频时长超时。")), 12000);

    function finish(result: number | Error) {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeout);
      video.removeAttribute("src");
      video.load();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      if (result instanceof Error) reject(result);
      else resolve(result);
    }

    video.preload = "metadata";
    video.muted = true;
    video.playsInline = true;
    video.onloadedmetadata = () => Number.isFinite(video.duration) && video.duration > 0
      ? finish(video.duration)
      : finish(new Error("无法读取视频时长。"));
    video.onerror = () => finish(new Error("无法读取视频时长。"));
    video.src = url;
    video.load();
  });
}

export default function StudioPage() {
  const [assets, setAssets] = useState<StudioAsset[]>([]);
  const [generations, setGenerations] = useState<GenerationRecord[]>([]);
  const [mode, setMode] = useState<StudioMode>("generate");
  const [prompt, setPrompt] = useState("");
  const [references, setReferences] = useState<{ assetId: string; role: AssetRole }[]>([]);
  const [ratio, setRatio] = useState<GenerationInput["ratio"]>("9:16");
  const [duration, setDuration] = useState(30);
  const [resolution, setResolution] = useState<GenerationInput["resolution"]>("720p");
  const [selectedModelId, setSelectedModelId] = useState(MODEL_ID);
  const [editStart, setEditStart] = useState(0);
  const [editEnd, setEditEnd] = useState(5);
  const [parentGenerationId, setParentGenerationId] = useState("");
  const [activePanel, setActivePanel] = useState<Panel>(null);
  const [mention, setMention] = useState<PromptMention | null>(null);
  const [mentionIndex, setMentionIndex] = useState(0);
  const promptRef = useRef<PromptEditorHandle>(null);
  const composerRef = useRef<HTMLFormElement>(null);
  const [mentionPosition, setMentionPosition] = useState<CSSProperties>();
  const promptSelectionRef = useRef({ start: 0, end: 0 });
  const composingRef = useRef(false);
  const [assetDraft, setAssetDraft] = useState({ name: "", type: "image", purpose: "" });
  const [assetFile, setAssetFile] = useState<File | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [storageBusy, setStorageBusy] = useState(false);
  const [deletingAssetId, setDeletingAssetId] = useState<string | null>(null);
  const [deletingGenerationId, setDeletingGenerationId] = useState<string | null>(null);
  const [previewAsset, setPreviewAsset] = useState<StudioAsset | null>(null);
  const [assetDurations, setAssetDurations] = useState<Record<string, number>>({});
  const [durationFailures, setDurationFailures] = useState<Record<string, true>>({});
  const durationLoadingRef = useRef(new Set<string>());
  const temporaryInputRef = useRef<HTMLInputElement>(null);
  const submissionRef = useRef<{ body: string; id: string; recordId?: string } | null>(null);
  const submittingRef = useRef(false);
  const [runtimeMode, setRuntimeMode] = useState<"hosted" | "local" | null>(null);
  const [generateAudio, setGenerateAudio] = useState(true);
  const [r2AccountDraft, setR2AccountDraft] = useState("");
  const [r2BucketDraft, setR2BucketDraft] = useState("seedance-studio-private");
  const [r2Jurisdiction, setR2Jurisdiction] = useState<"default" | "eu" | "us" | "fedramp">("default");
  const [r2AccessKeyDraft, setR2AccessKeyDraft] = useState("");
  const [r2SecretDraft, setR2SecretDraft] = useState("");
  const [providerSettings, setProviderSettings] = useState<ProviderSettingsStatus>({ configured: false, source: "none", tokenHint: "", baseUrl: DEFAULT_TEMPLATE.endpoints.generation!.defaultUrl, persistent: false, bindingId: "", model: MODEL_ID, template: DEFAULT_TEMPLATE, endpoints: Object.fromEntries(Object.entries(DEFAULT_TEMPLATE.endpoints).map(([key, spec]) => [key, spec.defaultUrl])), parameters: {}, credentialHints: {}, canRegisterAssets: false, locked: false });
  const [storageStatus, setStorageStatus] = useState<StorageStatus>({ configured: false, provider: "Cloudflare R2", private: true, state: "disconnected" });

  async function load() {
    const [assetResponse, generationResponse, settingsResponse, storageResponse] = await Promise.all([fetch("/api/assets"), fetch("/api/generations"), fetch("/api/settings/provider"), fetch("/api/settings/storage")]);
    if (assetResponse.ok) setAssets(await assetResponse.json());
    if (generationResponse.ok) setGenerations(await generationResponse.json());
    if (settingsResponse.ok) {
      const settings = await settingsResponse.json() as ProviderSettingsStatus;
      setProviderSettings(settings);
    }
    if (storageResponse.ok) {
      const storage = await storageResponse.json() as StorageStatus;
      setStorageStatus(storage); setR2AccountDraft((value) => value || storage.accountId || ""); setR2BucketDraft((value) => value || storage.bucket || ""); setR2Jurisdiction(storage.jurisdiction || "default");
    }
  }

  useEffect(() => { void load().catch(() => setMessage("工作区暂时无法加载，请刷新重试。")); void fetch("/api/runtime").then(response => response.json()).then(data => setRuntimeMode(data.mode)).catch(() => {}); }, []);
  const pendingIds = generations.filter((item) => item.status === "WAITING_PROVIDER").map((item) => item.id).join(",");
  useEffect(() => {
    if (!pendingIds) return;
    let stopped = false; let timer: number | undefined;
    const poll = async () => {
      await Promise.all(pendingIds.split(",").map((id) => fetch(`/api/generations/${id}`)));
      await load();
      if (!stopped) timer = window.setTimeout(poll, 7000);
    };
    void poll();
    return () => { stopped = true; if (timer) window.clearTimeout(timer); };
  }, [pendingIds]);

  useEffect(() => {
    for (const asset of assets) {
      if (asset.type !== "video" || assetDurations[asset.id] || durationFailures[asset.id] || durationLoadingRef.current.has(asset.id)) continue;
      durationLoadingRef.current.add(asset.id);
      void readVideoDuration(asset.sourceUrl)
        .then((measured) => {
          setAssetDurations((current) => ({ ...current, [asset.id]: measured }));
        })
        .catch(() => {
          setDurationFailures((current) => ({ ...current, [asset.id]: true }));
        })
        .finally(() => durationLoadingRef.current.delete(asset.id));
    }
  }, [assets]);

  const assetMap = useMemo(() => new Map(assets.map((asset) => [asset.id, asset])), [assets]);
  const referenceDraftRef = useRef({ references, assetMap, prompt });
  useEffect(() => { referenceDraftRef.current = { references, assetMap, prompt }; }, [references, assetMap, prompt]);
  const libraryAssets = useMemo(() => assets.filter((asset) => asset.providerStatus !== "temporary"), [assets]);
  const labels = useMemo(() => referenceLabels(references, assetMap), [references, assetMap]);
  const editorReferences = useMemo(() => [...labels].flatMap(([assetId, label]) => {
    const asset = assetMap.get(assetId);
    return asset ? [{ asset, label }] : [];
  }), [labels, assetMap]);
  const mentionAssets = useMemo(() => {
    const selected = references.flatMap((reference) => {
      const asset = assetMap.get(reference.assetId);
      return asset ? [asset] : [];
    });
    const query = mention?.query.toLocaleLowerCase() ?? "";
    return [...selected, ...libraryAssets.filter((asset) => !labels.has(asset.id))].filter((asset) =>
      !query || [asset.name, asset.purpose, labels.get(asset.id) ?? ""].some((text) => text.toLocaleLowerCase().includes(query))
    );
  }, [references, assetMap, libraryAssets, labels, mention]);
  const counts = useMemo(() => references.reduce((result, reference) => {
    const type = assetMap.get(reference.assetId)?.type;
    if (type) result[type] += 1;
    return result;
  }, { image: 0, video: 0, audio: 0 }), [references, assetMap]);
  const template = providerSettings.template;
  const selectedModel = template.models.find(model => model.id === selectedModelId) ?? template.models[0];
  const caps = capabilitiesFor(template, selectedModel.id);
  const availableResolutions = caps.resolutions;
  const maxDuration = mode === "extend" ? caps.maxExtendDuration ?? caps.maxDuration : caps.maxDuration;
  useEffect(() => { setSelectedModelId(providerSettings.model); }, [providerSettings.bindingId]);
  useEffect(() => {
    if (!caps.modes.includes(mode)) setMode(caps.modes[0]);
    if (!caps.resolutions.includes(resolution)) setResolution(caps.resolutions[0]);
    if (!caps.ratios.includes(ratio)) setRatio(caps.ratios[0]);
    setDuration(value => Math.max(caps.minDuration, Math.min(value, maxDuration)));
    if (caps.audio !== "optional") setGenerateAudio(caps.audio === "required");
  }, [providerSettings.bindingId, selectedModel.id, mode]);
  const containsVideoInput = counts.video > 0 || (mode === "extend" && Boolean(parentGenerationId));
  const referencedVideoIds = references.filter((reference) => assetMap.get(reference.assetId)?.type === "video").map((reference) => reference.assetId);
  const parentVideoDuration = mode === "extend" && parentGenerationId
    ? generations.find((generation) => generation.id === parentGenerationId)?.input.duration ?? 0
    : 0;
  const inputVideoDuration = parentVideoDuration + referencedVideoIds.reduce((sum, assetId) => sum + (assetDurations[assetId] ?? 0), 0);
  const hasPendingVideoDuration = referencedVideoIds.some((assetId) => !assetDurations[assetId] && !durationFailures[assetId]);
  const hasUnreadableVideoDuration = referencedVideoIds.some((assetId) => durationFailures[assetId]);
  const price = template.id === "kkidc" && providerSettings.endpoints.generation === DEFAULT_TEMPLATE.endpoints.generation!.defaultUrl && DEFAULT_TEMPLATE.models.some(item => item.id === selectedModel.id) ? calculateSeedancePrice({ model: selectedModel.id, resolution, ratio, duration, containsVideoInput, inputVideoDuration }) : null;

  function selectMode(nextMode: StudioMode) {
    setMode(nextMode); replaceReferences([]); setActivePanel(null);
    setDuration(value => Math.min(value, nextMode === "extend" ? caps.maxExtendDuration ?? caps.maxDuration : caps.maxDuration));
  }

  function roleForAsset(asset: StudioAsset): AssetRole {
    return mode === "edit" ? "source_video" : mode === "green_screen" ? "green_screen_subject" : mode === "white_model" ? "white_model" : asset.type === "audio" ? "sound" : asset.type === "video" ? "motion" : "identity";
  }

  function addReference(asset: StudioAsset) {
    if (references.some((item) => item.assetId === asset.id)) return;
    if (counts[asset.type] >= caps.references[asset.type]) { setMessage(`当前模型的 ${asset.type} 参考上限为 ${caps.references[asset.type]} 个。`); return; }
    setReferences((current) => [...current, { assetId: asset.id, role: roleForAsset(asset) }]);
  }

  function replaceReferences(update: typeof references | ((current: typeof references) => typeof references)) {
    const current = referenceDraftRef.current;
    const next = typeof update === "function" ? update(current.references) : update;
    const remap = (value: string) => remapPromptMentions(value, current.references, next, current.assetMap);
    const nextPrompt = remap(current.prompt);
    const start = Math.min(remap(current.prompt.slice(0, promptSelectionRef.current.start)).length, nextPrompt.length);
    const end = Math.min(remap(current.prompt.slice(0, promptSelectionRef.current.end)).length, nextPrompt.length);
    promptSelectionRef.current = { start, end };
    setPrompt(nextPrompt);
    setMention(findPromptMention(nextPrompt, start, end));
    setActivePanel((panel) => panel === "mention" ? null : panel);
    referenceDraftRef.current = { ...current, references: next, prompt: nextPrompt };
    setReferences(next);
    requestAnimationFrame(() => promptRef.current?.setSelectionRange(start, end));
  }

  function positionMentionPanel() {
    const caret = promptRef.current?.getCaretRect();
    const composer = composerRef.current?.getBoundingClientRect();
    if (!composer) return;
    const width = Math.min(340, composer.width - 24);
    const top = caret?.top ?? composer.top;
    setMentionPosition({
      width,
      left: Math.max(12, Math.min((caret?.left ?? composer.left + 100) - composer.left, composer.width - width - 12)),
      bottom: composer.bottom - top + 10,
      maxHeight: Math.max(100, Math.min(420, top - 16)),
    });
  }

  function activePromptMention(value: string, start: number, end: number) {
    const next = findPromptMention(value, start, end);
    return next && [...labels.values()].includes(next.query) ? null : next;
  }

  function updatePromptSelection(selection: PromptEditorSelection) {
    const { selectionStart: start, selectionEnd: end, value } = selection;
    const previousSelection = promptSelectionRef.current;
    promptSelectionRef.current = { start, end };
    if (composingRef.current) return;
    const next = activePromptMention(value, start, end);
    if (previousSelection.start === start && previousSelection.end === end &&
      mention?.start === next?.start && mention?.end === next?.end && mention?.query === next?.query) return;
    setMention(next);
    setMentionIndex(0);
    if (next) positionMentionPanel();
    setActivePanel((current) => next ? "mention" : current === "mention" ? null : current);
  }

  function openMentionPicker() {
    if (activePanel === "mention") { setActivePanel(null); return; }
    const { start, end } = promptSelectionRef.current;
    setMention(activePromptMention(prompt, start, end));
    setMentionIndex(0);
    positionMentionPanel();
    setActivePanel("mention");
  }

  function resetComposerAfterSuccessfulSubmission() {
    promptSelectionRef.current = { start: 0, end: 0 };
    composingRef.current = false;
    referenceDraftRef.current = { ...referenceDraftRef.current, references: [], prompt: "" };
    setPrompt("");
    setReferences([]);
    setMention(null);
    setMentionIndex(0);
    setActivePanel(null);
    if (temporaryInputRef.current) temporaryInputRef.current.value = "";
    requestAnimationFrame(() => {
      promptRef.current?.focus();
      promptRef.current?.setSelectionRange(0, 0);
    });
  }

  function insertReference(asset: StudioAsset) {
    const selected = references.some((item) => item.assetId === asset.id);
    const next = selected ? references : [...references, { assetId: asset.id, role: roleForAsset(asset) }];
    const limit = caps.references[asset.type];
    if (!selected && counts[asset.type] >= limit) {
      setMessage(`此类参考最多 ${limit} 个，请先移除不需要的参考。`);
      return;
    }
    const label = referenceLabels(next, assetMap).get(asset.id)!;
    const inserted = insertPromptMention(prompt, label, mention ?? promptSelectionRef.current);
    setReferences(next);
    setPrompt(inserted.value);
    setMention(null);
    setActivePanel(null);
    requestAnimationFrame(() => {
      promptRef.current?.focus();
      promptRef.current?.setSelectionRange(inserted.caret, inserted.caret);
      promptSelectionRef.current = { start: inserted.caret, end: inserted.caret };
    });
  }

  function handlePromptKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    if (composingRef.current || event.nativeEvent.isComposing || activePanel !== "mention") return;
    if (event.key === "Escape") { event.preventDefault(); setActivePanel(null); return; }
    if (!mentionAssets.length) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      setMentionIndex((current) => (current + step + mentionAssets.length) % mentionAssets.length);
    } else if (event.key === "Enter") {
      event.preventDefault();
      insertReference(mentionAssets[Math.min(mentionIndex, mentionAssets.length - 1)]);
    }
  }

  async function uploadTemporaryReferences(event: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files ?? []);
    event.target.value = "";
    if (!files.length) return;
    setBusy(true); setMessage("正在上传临时参考到私有 R2…");
    const created: StudioAsset[] = [];
    const nextCounts = { ...counts };
    try {
      for (const file of files) {
        const type = file.type.startsWith("image/") ? "image" : file.type.startsWith("video/") ? "video" : file.type.startsWith("audio/") ? "audio" : undefined;
        if (!type) throw new Error(`不支持文件“${file.name}”的格式。`);
        const measuredVideoDuration = type === "video" ? await readVideoDuration(file).catch(() => undefined) : undefined;
        const limit = caps.references[type];
        if (nextCounts[type] >= limit) throw new Error(`${type === "image" ? "图片" : type === "video" ? "视频" : "音频"}参考最多 ${limit} 个。`);
        const signedResponse = await fetch("/api/assets/upload", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ filename: file.name, contentType: file.type, size: file.size, type }),
        });
        const signed = await signedResponse.json();
        if (!signedResponse.ok) throw new Error(signed.error);
        const uploaded = await fetch(signed.uploadUrl, { method: "PUT", headers: { "Content-Type": file.type }, body: file });
        if (!uploaded.ok) throw new Error(`R2 上传失败（${uploaded.status}）。`);
        const response = await fetch("/api/assets", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: file.name, type, purpose: "临时参考", storageKey: signed.objectKey, uploadReceipt: signed.uploadReceipt, temporary: true }),
        });
        const asset = await response.json();
        if (!response.ok) throw new Error(asset.error);
        if (measuredVideoDuration) setAssetDurations((current) => ({ ...current, [asset.id]: measuredVideoDuration }));
        created.push(asset); nextCounts[type] += 1;
      }
      setAssets((current) => [...created, ...current]);
      setReferences((current) => [...current, ...created.map((asset) => ({ assetId: asset.id, role: roleForAsset(asset) }))]);
      setMessage(`已添加 ${created.length} 个临时参考，不进入素材库且无需登记审核。`);
    } catch (error) {
      if (created.length) {
        setAssets((current) => [...created, ...current]);
        setReferences((current) => [...current, ...created.map((asset) => ({ assetId: asset.id, role: roleForAsset(asset) }))]);
      }
      setMessage(error instanceof Error ? error.message : "临时参考上传失败。");
    } finally {
      setBusy(false);
    }
  }

  async function createAsset(event: React.SyntheticEvent) {
    event.preventDefault(); setBusy(true); setMessage("");
    try {
      let storageKey: string | undefined;
      let uploadReceipt: string | undefined;
      const measuredVideoDuration = assetFile && (assetDraft.type === "video" || assetFile.type.startsWith("video/"))
        ? await readVideoDuration(assetFile).catch(() => undefined)
        : undefined;
      if (assetFile) {
        setMessage("正在通过签名地址直传到私有 R2…");
        const signedResponse = await fetch("/api/assets/upload", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ filename: assetFile.name, contentType: assetFile.type, size: assetFile.size, type: assetDraft.type }),
        });
        const signed = await signedResponse.json();
        if (!signedResponse.ok) throw new Error(signed.error);
        const uploaded = await fetch(signed.uploadUrl, { method: "PUT", headers: { "Content-Type": assetFile.type }, body: assetFile });
        if (!uploaded.ok) throw new Error(`R2 上传失败（${uploaded.status}）。`);
        storageKey = signed.objectKey;
        uploadReceipt = signed.uploadReceipt;
      }
      const response = await fetch("/api/assets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...assetDraft, name: assetDraft.name.trim() || assetFile?.name, storageKey, uploadReceipt }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error);
      if (measuredVideoDuration) setAssetDurations((current) => ({ ...current, [data.id]: measuredVideoDuration }));
      setAssets([data, ...assets]); setAssetDraft({ name: "", type: "image", purpose: "" }); setAssetFile(null);
      setMessage(providerSettings.template.operations.registerAsset ? "素材已保存到私有 R2。人物素材请先登记审核。" : "素材已保存到私有 R2。");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "素材上传失败。");
    } finally {
      setBusy(false);
    }
  }

  async function copyProviderAssetId(asset: StudioAsset) {
    if (!asset.providerAssetId) return;
    try {
      await navigator.clipboard.writeText(asset.providerAssetId);
      setMessage(`已复制「${asset.name}」的供应商 ID。`);
    } catch {
      setMessage("复制失败，请选中供应商 ID 后手动复制。");
    }
  }

  async function registerAsset(asset: StudioAsset) {
    setBusy(true); setMessage("");
    const refreshing = Boolean(asset.providerAssetId) && asset.providerBindingId === providerSettings.bindingId;
    try {
      const response = await fetch(`/api/assets/${asset.id}/register`, { method: refreshing ? "GET" : "POST" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error);
      setAssets((current) => current.map((item) => item.id === data.id ? data : item)); setMessage(`素材${refreshing ? "刷新" : "登记"}状态：${data.providerStatus}`);
    } catch (error) {
      setMessage(`${refreshing ? "刷新" : "登记"}失败：${error instanceof Error ? error.message : "请稍后重试。"}`);
    } finally {
      setBusy(false);
    }
  }

  async function deleteAsset(asset: StudioAsset) {
    const confirmed = window.confirm(`确定永久删除「${asset.name}」吗？\n\n如果素材保存在 Cloudflare R2，云端文件也会同步删除。此操作无法撤销。`);
    if (!confirmed) return;
    setDeletingAssetId(asset.id); setMessage("");
    try {
      const response = await fetch(`/api/assets/${asset.id}`, { method: "DELETE" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error);
      setAssets((current) => current.filter((item) => item.id !== asset.id));
      replaceReferences((current) => current.filter((item) => item.assetId !== asset.id));
      setMessage(data.deletedFromR2 ? "素材与 Cloudflare R2 云端文件已删除。" : "素材记录已删除；原始公网文件未被修改。");
    } catch (error) {
      setMessage(`删除失败：${error instanceof Error ? error.message : "请稍后重试。"}`);
    } finally {
      setDeletingAssetId(null);
    }
  }

  async function removeReference(asset: StudioAsset) {
    if (asset.providerStatus !== "temporary") {
      replaceReferences(references.filter((item) => item.assetId !== asset.id));
      return;
    }
    const confirmed = window.confirm(`移除临时参考“${asset.name}”，并同步删除 Cloudflare R2 文件吗？`);
    if (!confirmed) return;
    replaceReferences(references.filter((item) => item.assetId !== asset.id));
    try {
      const response = await fetch(`/api/assets/${asset.id}`, { method: "DELETE" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error);
      setAssets((current) => current.filter((item) => item.id !== asset.id));
      setMessage("临时参考及 R2 文件已删除。");
    } catch (error) {
      setMessage(`临时参考已从本次创作移除；${error instanceof Error ? error.message : "云端记录暂时保留。"}`);
    }
  }

  async function deleteGeneration(generation: GenerationRecord) {
    const confirmed = window.confirm(`确定永久删除作品“${generation.prompt.slice(0, 40)}”吗？\n\n如果成品保存在 Cloudflare R2，云端视频也会同步删除。此操作无法撤销。`);
    if (!confirmed) return;
    setDeletingGenerationId(generation.id); setMessage("");
    try {
      const response = await fetch(`/api/generations/${generation.id}`, { method: "DELETE" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error);
      setGenerations((current) => current.filter((item) => item.id !== generation.id));
      if (parentGenerationId === generation.id) setParentGenerationId("");
      setMessage(data.deletedFromR2 ? "作品及 Cloudflare R2 成品已删除。" : "作品记录已删除。供应商临时文件未被修改。");
    } catch (error) {
      setMessage(`删除失败：${error instanceof Error ? error.message : "请稍后重试。"}`);
    } finally {
      setDeletingGenerationId(null);
    }
  }

  async function saveStorageSettings() {
    setStorageBusy(true); setMessage("");
    try {
      const response = await fetch("/api/settings/storage", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ accountId: r2AccountDraft, bucket: r2BucketDraft, jurisdiction: r2Jurisdiction, accessKeyId: r2AccessKeyDraft, secretAccessKey: r2SecretDraft }) });
      const data = await response.json(); if (!response.ok) throw new Error(data.error);
      setStorageStatus(data); setR2AccessKeyDraft(""); setR2SecretDraft("");
      const probe = await fetch("/api/settings/storage", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      const probeData = await probe.json(); if (!probe.ok) throw new Error(probeData.error);
      const uploaded = await fetch(probeData.uploadUrl, { method: "PUT", headers: { "Content-Type": "text/plain" }, body: "ok" });
      if (!uploaded.ok) throw new Error("浏览器无法上传到 R2，请按 CORS 指引配置后重试。");
      const headed = await fetch(probeData.headUrl, { method: "HEAD" });
      if (!headed.ok) throw new Error("浏览器无法读取 R2，请按 CORS 指引配置后重试。");
      const verified = await fetch("/api/settings/storage", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ objectKey: probeData.objectKey }) });
      const verifiedData = await verified.json(); if (!verified.ok) throw new Error(verifiedData.error);
      setStorageStatus(verifiedData); setMessage("Cloudflare R2 已连接并通过浏览器 CORS 验证。");
    } catch (error) { setMessage(error instanceof Error ? error.message : "R2 验证失败。"); }
    finally { setStorageBusy(false); }
  }

  async function clearStorageSettings() {
    setStorageBusy(true); setMessage("");
    const response = await fetch("/api/settings/storage", { method: "DELETE" });
    const data = await response.json(); setStorageBusy(false); setStorageStatus(data); setR2AccessKeyDraft(""); setR2SecretDraft("");
    setMessage("R2 已断开；你的 Bucket 内文件不会被删除。");
  }

  async function resolveUncertain(id: string, kind: "generations" | "assets") {
    const value = window.prompt("先到供应商控制台核对这次提交。\n\n若已创建，请粘贴供应商 ID；若确定没有创建，请输入：未创建");
    if (!value?.trim()) return;
    const notCreated = value.trim() === "未创建";
    if (notCreated && !window.confirm("确认你已检查供应商控制台，且这次提交没有产生任务或登记记录？")) return;
    setBusy(true);
    try {
      const response = await fetch(`/api/${kind}/${id}/resolve-submission`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(notCreated ? { confirmNotSubmitted: true } : { providerId: value.trim() }) });
      const data = await response.json(); if (!response.ok) throw new Error(data.error);
      if (submissionRef.current?.recordId === id) submissionRef.current = null;
      await load(); setMessage(notCreated ? "已记录核对结果，原请求不会自动重发。" : "已绑定供应商 ID，可以继续刷新状态。");
    } catch (error) { setMessage(error instanceof Error ? error.message : "核对结果保存失败。"); }
    finally { setBusy(false); }
  }

  async function retryStorage(generation: GenerationRecord) {
    setBusy(true); setMessage("");
    try {
      const response = await fetch(`/api/generations/${generation.id}/retry-storage`, { method: "POST" });
      const data = await response.json(); if (!response.ok) throw new Error(data.error);
      setGenerations((current) => current.map((item) => item.id === generation.id ? data : item));
      setMessage("已重新启动后台归档。");
    } catch (error) { setMessage(error instanceof Error ? error.message : "重新归档失败。"); }
    finally { setBusy(false); }
  }

  async function copyCorsRule() {
    const rule = JSON.stringify({ rules: [{ id: "seedance-user-bucket-signed-access", allowed: { origins: [window.location.origin], methods: ["GET", "PUT", "HEAD"], headers: ["Content-Type"] }, exposeHeaders: ["ETag"], maxAgeSeconds: 3600 }] }, null, 2);
    await navigator.clipboard.writeText(rule); setMessage("R2 CORS 规则已复制；请贴到 Cloudflare Bucket 的 CORS Policy。");
  }

  async function signOut() { await authClient.signOut(); window.location.assign("/login"); }
  async function deleteAccount() {
    if (!window.confirm("删除账户会清除平台中的设置和创作记录，但不会删除你自己的 R2 文件。确定继续吗？")) return;
    const result = await authClient.deleteUser({ callbackURL: "/login" });
    if (result.error) { setMessage(result.error.message || "删除账户失败，请重试。"); return; }
    window.location.assign("/login");
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (submittingRef.current) return;
    submittingRef.current = true; setBusy(true); setMessage(""); setActivePanel(null);
    const input: GenerationInput = { model: selectedModel.id, mode, prompt, ratio, duration, resolution, generateAudio, references, ...(parentGenerationId ? { parentGenerationId } : {}), ...(mode === "edit" ? { editRange: { start: editStart, end: editEnd } } : {}) };
    const body = JSON.stringify(input);
    if (submissionRef.current && submissionRef.current.body !== body) {
      setMessage("上一请求结果尚未确认，请先恢复原内容并重试，避免重复计费。");
      submittingRef.current = false; setBusy(false); return;
    }
    submissionRef.current ??= { body, id: crypto.randomUUID() };
    try {
      const response = await fetch("/api/generations", { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": submissionRef.current.id }, body });
      const data = await response.json();
      if (!response.ok) { if (response.status < 500) submissionRef.current = null; setMessage(data.error); return; }
      if (submissionRef.current) submissionRef.current.recordId = data.id;
      if (data.status === "FAILURE") submissionRef.current = null;
      if (data.providerTaskId) {
        submissionRef.current = null;
        resetComposerAfterSuccessfulSubmission();
      }
      setGenerations((current) => [...current.filter(item => item.id !== data.id), data]);
      setMessage(data.status === "FAILURE" ? data.errorMessage || "供应商拒绝了此次请求，请修改后重试。" : data.providerTaskId ? "任务已提交，最新作品会显示在列表底部。" : "提交结果待核对；重试不会重复提交给供应商，请勿另建相同任务。");
    } catch { setMessage("连接中断；恢复后点击重试，将使用同一识别码确认结果。"); }
    finally { submittingRef.current = false; setBusy(false); }
  }

  function editAgain(generation: GenerationRecord) {
    if (!template.models.some(item => item.id === generation.model) || !capabilitiesFor(template, generation.model).modes.includes(generation.mode)) { setMessage("当前供应商不支持这项作品的模型或模式，请先切换到兼容的供应商。"); return; }
    setMode(generation.mode); setPrompt(generation.prompt); setRatio(generation.input.ratio); setDuration(generation.input.duration);
    setResolution(generation.input.resolution); setReferences(generation.input.references ?? []);
    if (template.models.some(model => model.id === generation.model)) setSelectedModelId(generation.model);
    window.scrollTo({ top: document.body.scrollHeight, behavior: "smooth" });
  }

  function generationReferenceAssets(generation: GenerationRecord) {
    return (generation.input.references ?? []).flatMap((reference) => {
      const asset = assetMap.get(reference.assetId);
      if (asset) return [asset];
      if (!reference.assetId.startsWith("generation:")) return [];
      const source = generations.find((item) => item.id === reference.assetId.slice("generation:".length));
      const sourceUrl = source?.savedVideoUrl;
      if (!source || !sourceUrl) return [];
      return [{
        id: reference.assetId,
        name: "延长源视频",
        type: "video" as const,
        purpose: "延长源视频",
        sourceUrl,
        providerStatus: "ready" as const,
        createdAt: source.createdAt,
      }];
    });
  }

  return <main className="dream-app">
    <header className="dream-header">
      <div className="brand"><span className="brand-mark">M</span><div><b>Metadawn studio</b><small>专业视频创作</small></div></div>
      <div className="header-actions"><span className={`provider-dot ${providerSettings.configured ? "" : "offline"}`} /><span>{providerSettings.configured ? `${providerSettings.template.name} 已配置` : "API 未设置"}</span><button type="button" className="api-settings-trigger" onClick={() => setActivePanel(activePanel === "settings" ? null : "settings")}>API 设置</button>{runtimeMode === "hosted" && <button type="button" onClick={() => void signOut()}>退出</button>}{runtimeMode === "local" && <span className="local-mode-badge">本地工作区</span>}<button type="button" onClick={() => void load()}>刷新</button></div>
    </header>

    <section className="creation-feed">
      <div className="feed-heading"><div><h1>我的创作</h1><p>围绕一个灵感持续生成、编辑和延长</p></div><span>{generations.length} 个作品</span></div>
      {generations.length === 0 ? <div className="feed-empty"><span>✦</span><h2>从一个想法开始</h2><p>在下方描述画面，或添加图片、视频、音频作为参考</p></div> : <div className="result-list">
        {generations.map((generation) => { const resultAssets = generationReferenceAssets(generation); return <article className="result-card" key={generation.id}>
          <div className="result-meta">{resultAssets.length ? <div className="result-reference-stack" style={{ width: `${42 + Math.min(resultAssets.length - 1, 3) * 13}px` }}>{resultAssets.slice(0, 4).map((asset, index) => <button type="button" key={`${generation.id}-${asset.id}`} style={{ left: `${index * 13}px`, transform: `rotate(${(index - 1.5) * 2.5}deg)`, zIndex: index + 1 }} aria-label={`预览参考素材 ${asset.name}`} onClick={() => setPreviewAsset(asset)}><AssetVisual asset={asset} /></button>)}{resultAssets.length > 4 && <span>+{resultAssets.length - 4}</span>}</div> : <span className="mini-avatar">M</span>}<div className="result-copy"><b>{generation.prompt}</b><p>{modeCopy[generation.mode].label}　|　{generation.input.duration}s　|　{generation.input.ratio}　|　{generation.input.resolution}</p></div><span className={`result-status ${generation.status.toLowerCase()}`}>{formatStatus(generation.status)}</span></div>
          <div className={`video-stage ratio-${generation.input.ratio.replace(":", "-")}`}>
            {generation.savedVideoUrl ? <video controls preload="metadata" src={generation.savedVideoUrl} /> : <div className="video-placeholder"><span>{generation.status === "FAILURE" || generation.status === "STORAGE_ERROR" ? "!" : "✦"}</span><p>{generation.errorMessage ?? (generation.status === "ARCHIVING" ? "正在保存到你的 R2…" : "等待模型响应…")}</p></div>}
          </div>
          <div className="result-actions">{generation.status === "WAITING_PROVIDER" && !generation.providerTaskId && <button type="button" disabled={busy} onClick={() => void resolveUncertain(generation.id, "generations")}>核对提交结果</button>}<button type="button" onClick={() => editAgain(generation)}>▱ 重新编辑</button><button type="button" onClick={() => editAgain(generation)}>↻ 再次生成</button>{generation.status === "STORAGE_ERROR" && <button type="button" disabled={busy || !storageStatus.configured} onClick={() => void retryStorage(generation)}>↥ 重新归档</button>}<a className={`download-result ${!generation.savedVideoUrl ? "disabled" : ""}`} aria-disabled={!generation.savedVideoUrl} href={generation.savedVideoUrl ? `/api/generations/${generation.id}/download` : undefined} download={`metadawn-${generation.id}.mp4`}>⇩ 下载</a><button type="button" className="delete-result" disabled={deletingGenerationId === generation.id} onClick={() => void deleteGeneration(generation)}>{deletingGenerationId === generation.id ? "删除中…" : "⌫ 删除"}</button></div>
        </article>})}
      </div>}
    </section>

    <form ref={composerRef} className="dream-composer" onSubmit={submit}>
      {activePanel && <><button type="button" className="panel-backdrop" aria-label="关闭弹窗" onClick={() => setActivePanel(null)} /><div className={`floating-panel ${activePanel === "mention" ? "mention-panel" : ""} ${activePanel === "assets" ? "assets-panel" : ""} ${activePanel === "settings" ? "settings-panel" : ""}`} style={activePanel === "mention" ? mentionPosition : undefined}>
        {activePanel === "settings" && <div className="api-settings"><div className="settings-head"><div><p className="panel-title">服务与存储设置</p><small>自备生成凭证、素材登记凭证与 Cloudflare R2</small></div><button type="button" onClick={() => setActivePanel(null)}>×</button></div><ProviderSettingsForm pendingTasks={generations} pendingAssets={assets} status={providerSettings} onSaved={settings => { setProviderSettings(settings); setSelectedModelId(settings.model); }} onMessage={setMessage} /><div className={`storage-status ${storageStatus.configured ? "connected" : ""}`}><span>{storageStatus.configured ? "✓" : "!"}</span><div><b>你的 Cloudflare R2 私有存储</b><small>{storageStatus.configured ? `${storageStatus.bucket} · ${storageStatus.accessKeyHint} · 已验证` : storageStatus.state === "needs_cors" ? "请完成浏览器 CORS 验证" : "需要专用、私有、空白 Bucket"}</small></div></div><div className="r2-credentials"><p>连接你自己的 R2（请自行确认 Object Read & Write 仅限此 Bucket；平台只验证读写能力，不审核 Key 权限范围）</p><label><span>Account ID</span><input value={r2AccountDraft} onChange={(event) => setR2AccountDraft(event.target.value)} /></label><label><span>Bucket（必须专用且空白）</span><input value={r2BucketDraft} onChange={(event) => setR2BucketDraft(event.target.value)} /></label><label><span>Bucket jurisdiction</span><select value={r2Jurisdiction} onChange={(event) => setR2Jurisdiction(event.target.value as typeof r2Jurisdiction)}><option value="default">Default</option><option value="eu">EU</option><option value="us">US</option><option value="fedramp" disabled>FedRAMP（暂不开放）</option></select></label><label><span>Access Key ID</span><input type="password" autoComplete="off" value={r2AccessKeyDraft} onChange={(event) => setR2AccessKeyDraft(event.target.value)} placeholder="R2 Access Key ID" /></label><label><span>Secret Access Key</span><input type="password" autoComplete="new-password" value={r2SecretDraft} onChange={(event) => setR2SecretDraft(event.target.value)} placeholder="仅加密保存，不会回传" /></label><div className="settings-actions"><button type="button" className="save-key" disabled={storageBusy || !r2AccountDraft.trim() || !r2BucketDraft.trim() || !r2AccessKeyDraft.trim() || !r2SecretDraft.trim()} onClick={() => void saveStorageSettings()}>{storageBusy ? "验证中…" : storageStatus.configured ? "轮换 R2 Key" : "连接并验证 R2"}</button>{storageStatus.state !== "disconnected" && <button type="button" className="clear-key" disabled={storageBusy} onClick={() => void clearStorageSettings()}>断开 R2</button>}</div></div><button type="button" className="copy-cors" onClick={() => void copyCorsRule()}>复制本网站的 R2 CORS 规则</button>{runtimeMode === "hosted" && <button type="button" className="delete-account" onClick={() => void deleteAccount()}>删除账户（保留你的 R2 文件）</button>}<p className="security-note">Bucket 必须保持 private，并在 Cloudflare Dashboard 只允许本网站来源的 GET、PUT、HEAD 与 Content-Type。平台不提供 R2；你的文件不会在断开或删帐后自动删除。</p></div>}
        {activePanel === "creation" && <><p className="panel-title">创作类型</p><div className="menu-list"><button type="button" disabled>⌁　Agent 模式 <em>稍后开放</em></button><button type="button" disabled>▧　图片生成</button><button type="button" className="selected">◉　视频生成 <span>✓</span></button><button type="button" disabled>♫　音乐生成</button><button type="button" disabled>◖　数字人</button></div></>}
        {activePanel === "model" && <><p className="panel-title">选择模型</p>{template.models.map((model, index) => <button type="button" key={model.id} className={`model-option ${selectedModel.id === model.id ? "selected" : ""}`} onClick={() => { setSelectedModelId(model.id);  setActivePanel(null); }}><span className="model-logo">✦</span><div><b>{model.label}{index === 0 && <i>New</i>}</b><p>{model.id}</p></div>{selectedModel.id === model.id && <strong>✓</strong>}</button>)}</>}
        {activePanel === "workflow" && <><p className="panel-title">视频工作流</p><div className="menu-list">{(Object.keys(modeCopy) as StudioMode[]).map((item) => <button type="button" key={item} disabled={!caps.modes.includes(item)} title={!caps.modes.includes(item) ? "当前供应商模型不支持" : undefined} className={mode === item ? "selected" : ""} onClick={() => selectMode(item)}><span>{modeCopy[item].icon}　{modeCopy[item].label}<small>{modeCopy[item].hint}</small></span>{mode === item && <b>✓</b>}</button>)}</div></>}
        {activePanel === "format" && <div className="format-panel"><p className="panel-title">选择比例</p><div className="choice-row ratio-row">{caps.ratios.map((item) => <button type="button" className={ratio === item ? "selected" : ""} onClick={() => setRatio(item)} key={item}><span className={`ratio-icon r-${item.replace(":", "-")}`} />{item}</button>)}</div><p className="panel-title">选择分辨率</p><div className="choice-row">{availableResolutions.map((item) => <button type="button" className={resolution === item ? "selected" : ""} onClick={() => setResolution(item)} key={item}>{item.toUpperCase()}<i>✦</i></button>)}</div><p className="panel-title">生成数量</p><div className="choice-row"><button type="button" className="selected">1</button><button type="button" disabled>2</button><button type="button" disabled>3</button><button type="button" disabled>4</button></div></div>}
        {activePanel === "duration" && <div className="duration-panel"><p className="panel-title">{mode === "extend" ? "选择超长视频生成时长" : "选择单次生成时长"}</p><input type="range" min={caps.minDuration} max={maxDuration} step="1" value={duration} onChange={(event) => setDuration(Number(event.target.value))} /><div className="duration-scale">{[caps.minDuration, Math.round((caps.minDuration + maxDuration) / 2), maxDuration].filter((value, index, array) => array.indexOf(value) === index).map((value) => <span key={value}>{value}</span>)}</div><div className="duration-value">{duration}<small>s</small></div><p>{`当前模型支持 ${caps.minDuration}–${maxDuration} 秒。${mode === "extend" ? "请先选择已完成作品。" : ""}`}</p></div>}
        {activePanel === "mention" && <div className="mention-content">
          <div className="mention-head"><div><p className="panel-title">选择参考内容</p><small>选取后插入缩图 · ↑↓ 选择，Enter 确认</small></div><button type="button" aria-label="关闭参考选择" onClick={() => setActivePanel(null)}>×</button></div>
          <button type="button" className="manage-assets" onClick={() => setActivePanel("assets")}><span>＋</span><b>管理素材库</b><small>上传、登记或删除长期素材</small></button>
          {mentionAssets.length === 0 ? <div className="mention-empty">{mention?.query ? "没有匹配的参考，请缩短 @ 后的名称" : "暂无参考，可用左侧＋上传或从素材库添加"}</div> : <div className="mention-list" id="reference-mentions" role="listbox" aria-label="参考内容">
            {mentionAssets.map((asset, index) => {
              const label = labels.get(asset.id);
              const insertionLabel = label ?? referenceLabels([...references, { assetId: asset.id, role: roleForAsset(asset) }], assetMap).get(asset.id);
              return <button type="button" role="option" id={`reference-mention-${asset.id}`} aria-selected={index === mentionIndex} aria-label={`引用 ${asset.name}${label ? `（@${label}）` : ""}`} className={index === mentionIndex ? "highlighted" : ""} key={asset.id} onMouseDown={(event) => event.preventDefault()} onClick={() => insertReference(asset)}>
                <span><AssetVisual asset={asset} /></span><div><b>{insertionLabel} · {asset.name}</b><small>{asset.providerStatus === "temporary" ? "本次临时参考" : asset.purpose || (asset.type === "image" ? "图片" : asset.type === "video" ? "视频" : "音频")}</small></div>{label && <i>✓</i>}
              </button>;
            })}
          </div>}
        </div>}
        {activePanel === "assets" && <div className="assets-content"><div className="assets-head"><div><p className="panel-title">可能 @ 的内容</p><p>素材库 · 当前模型支持 {caps.references.image} 张图片、{caps.references.video} 段视频和 {caps.references.audio} 段音频</p></div><button type="button" onClick={() => setActivePanel(null)}>×</button></div><div className="asset-create"><input value={assetDraft.name} onChange={(event) => setAssetDraft({ ...assetDraft, name: event.target.value })} placeholder="素材名称" /><select value={assetDraft.type} onChange={(event) => setAssetDraft({ ...assetDraft, type: event.target.value })}><option value="image">图片</option><option value="video">视频</option><option value="audio">音频</option></select><input value={assetDraft.purpose} onChange={(event) => setAssetDraft({ ...assetDraft, purpose: event.target.value })} placeholder="用途（人物／场景／动作…）" /><label className="file-picker">＋ 上传文件<input type="file" accept="image/*,video/mp4,video/quicktime,audio/mpeg,audio/wav" onChange={(event) => setAssetFile(event.target.files?.[0] ?? null)} /></label><button type="button" disabled={busy || !assetFile} onClick={createAsset}>加入素材库</button></div>{libraryAssets.length === 0 ? <div className="asset-empty"><span>⇧</span><p>素材库还是空的</p><small>创建需要长期复用或登记审核的素材</small></div> : <div className="asset-grid">{libraryAssets.map((asset) => { const selected = references.find((item) => item.assetId === asset.id); const deleting = deletingAssetId === asset.id; return <div className={`asset-tile ${selected ? "selected" : ""}`} key={asset.id}><button type="button" className="asset-main" disabled={deleting} onClick={() => selected ? replaceReferences(references.filter((item) => item.assetId !== asset.id)) : addReference(asset)}><span className={`asset-preview ${asset.type}`}><AssetVisual asset={asset} /></span><b>{asset.name}</b><small>{asset.purpose || asset.type}</small>{selected && <i>✓</i>}</button>{selected && <select value={selected.role} disabled={deleting} onChange={(event) => setReferences(references.map((item) => item.assetId === asset.id ? { ...item, role: event.target.value as AssetRole } : item))}>{roles.map((role) => <option value={role.value} key={role.value}>{role.label}</option>)}</select>}<div className="asset-provider-id"><span>供应商 ID</span><code>{asset.providerAssetId || "尚未取得"}</code><button type="button" disabled={!asset.providerAssetId || deleting} aria-label={`复制 ${asset.name} 的供应商 ID`} onClick={() => void copyProviderAssetId(asset)}>复制</button></div><div className="asset-actions">{asset.providerStatus === "processing" && !asset.providerAssetId && <button type="button" disabled={busy} onClick={() => void resolveUncertain(asset.id, "assets")}>核对登记结果</button>}{providerSettings.canRegisterAssets && (asset.providerStatus !== "ready" || asset.providerBindingId !== providerSettings.bindingId) && <button type="button" className="register" disabled={busy || deleting || asset.providerStatus === "processing" && !asset.providerAssetId} onClick={() => void registerAsset(asset)}>{asset.providerBindingId !== providerSettings.bindingId ? "在当前供应商登记" : asset.providerAssetId ? "刷新状态" : asset.providerStatus === "processing" ? "提交待确认" : "登记审核"}</button>}<button type="button" className="delete-asset" disabled={deleting} aria-label={`删除素材 ${asset.name}`} onClick={() => void deleteAsset(asset)}>{deleting ? "删除中…" : "删除"}</button></div></div>})}</div>}</div>}
      </div></>}

      {(mode === "extend" || mode === "edit") && <div className="advanced-row">{mode === "extend" && <label>延长自<select value={parentGenerationId} onChange={(event) => setParentGenerationId(event.target.value)} required><option value="">选择已完成作品</option>{generations.filter((item) => item.status === "READY").map((item) => <option value={item.id} key={item.id}>{item.prompt.slice(0, 52)}</option>)}</select></label>}{mode === "edit" && <><label>开始 <input type="number" min="0" value={editStart} onChange={(event) => setEditStart(Number(event.target.value))} /> 秒</label><label>结束 <input type="number" min="1" value={editEnd} onChange={(event) => setEditEnd(Number(event.target.value))} /> 秒</label></>}</div>}
      <div className="prompt-row"><div className={`reference-strip ${references.length ? "has-references" : ""}`} style={{ "--reference-count": references.length } as CSSProperties}>{references.map((reference, index) => { const asset = assetMap.get(reference.assetId); return asset && <div className="reference-chip" style={{ "--reference-index": index } as CSSProperties} key={asset.id}><button type="button" className="reference-thumb" aria-label={`预览 ${asset.name}`} onClick={() => setPreviewAsset(asset)}><AssetVisual asset={asset} /><span className="reference-expand">↗</span></button><button type="button" className="remove-reference" aria-label={`移除参考 ${asset.name}`} onClick={() => void removeReference(asset)}>×</button><span className="reference-name">@{labels.get(asset.id)} · {asset.name}</span><div className="reference-hover-preview"><b>@{labels.get(asset.id)} · {asset.name}</b><div><AssetVisual asset={asset} large /></div><small>{asset.providerStatus === "temporary" ? "临时参考" : roles.find((role) => role.value === reference.role)?.label}</small></div></div> })}<button type="button" className="add-reference" title="临时上传参考，不进入素材库" onClick={() => temporaryInputRef.current?.click()}>＋<small>临时参考</small></button></div><input ref={temporaryInputRef} className="temporary-file-input" type="file" multiple accept="image/*,video/mp4,video/quicktime,audio/mpeg,audio/wav" onChange={(event) => void uploadTemporaryReferences(event)} /><PromptEditor
        ref={promptRef}
        value={prompt}
        references={editorReferences}
        controls={activePanel === "mention" && mentionAssets.length ? "reference-mentions" : undefined}
        activeDescendant={activePanel === "mention" && mentionAssets.length ? `reference-mention-${mentionAssets[Math.min(mentionIndex, mentionAssets.length - 1)].id}` : undefined}
        onChange={(selection) => { setPrompt(selection.value); updatePromptSelection(selection); }}
        onSelectionChange={updatePromptSelection}
        onCompositionStart={() => { composingRef.current = true; }}
        onCompositionEnd={(selection) => { composingRef.current = false; updatePromptSelection(selection); }}
        onKeyDown={handlePromptKeyDown}
        placeholder="输入画面描述；输入 @ 选择素材，以缩图插入提示词。"
      /><span className="prompt-count">{prompt.length}/2000</span></div>
      <div className="composer-toolbar">
        <div className="tool-group"><button type="button" className={activePanel === "creation" ? "active" : ""} onClick={() => setActivePanel(activePanel === "creation" ? null : "creation")}>◉ <b>视频生成</b>⌄</button><button type="button" className={activePanel === "model" ? "active" : ""} onClick={() => setActivePanel(activePanel === "model" ? null : "model")}>◇ <b>{selectedModel.label}</b><i>✦</i></button><button type="button" className={activePanel === "workflow" ? "active" : ""} onClick={() => setActivePanel(activePanel === "workflow" ? null : "workflow")}>{modeCopy[mode].icon} <b>{modeCopy[mode].short}</b>⌄</button><button type="button" className={activePanel === "format" ? "active" : ""} onClick={() => setActivePanel(activePanel === "format" ? null : "format")}><span className="phone-icon" /> <b>{ratio}</b><em>{resolution}</em><i>✦</i><em>1</em></button><button type="button" className={activePanel === "duration" ? "active" : ""} onClick={() => setActivePanel(activePanel === "duration" ? null : "duration")}>◷ <b>{duration}s</b></button><button type="button" aria-label="引用参考内容" title="@ 已上传参考或素材库内容" className={activePanel === "mention" || activePanel === "assets" ? "active icon-only" : "icon-only"} onMouseDown={(event) => event.preventDefault()} onClick={openMentionPicker}>@</button></div>
        <div className="submit-side">{caps.audio === "optional" && <label className="audio-toggle"><input type="checkbox" checked={generateAudio} onChange={event => setGenerateAudio(event.target.checked)} />音频</label>}{price ? <div className="pricing-estimate" aria-label="预估计费" title={`计费单位 =（输入视频时长 ${price.inputVideoDuration.toFixed(2)} 秒 + 输出视频时长 ${price.outputVideoDuration} 秒）× ${price.width} × ${price.height} × ${price.fps} / 1024`}><span>预估 <b>{hasPendingVideoDuration ? "读取视频时长…" : hasUnreadableVideoDuration ? "无法完整估算" : `¥${price.total.toFixed(2)}`}</b></span><small>{hasUnreadableVideoDuration ? "部分输入视频时长无法读取，当前金额未包含该部分" : `${price.width}×${price.height} · ${price.fps}fps · (${price.inputVideoDuration.toFixed(1)}+${price.outputVideoDuration})s ÷1024 ≈ ${Math.round(price.billingUnits).toLocaleString()} 计费单位`}</small></div> : <div className="pricing-estimate"><span>以供应商账单为准</span></div>}<button className="send-button" disabled={busy || !prompt.trim() || !providerSettings.configured || !storageStatus.configured} aria-label="提交生成">{busy ? "…" : "↑"}</button></div>
      </div>
      <div className="composer-foot"><span>图片 {counts.image}/{caps.references.image}　视频 {counts.video}/{caps.references.video}　音频 {counts.audio}/{caps.references.audio}</span>{message && <p className={message.includes("失败") || message.includes("未配置") ? "error" : ""}>{message}</p>}</div>
    </form>
    {previewAsset && <div className="asset-lightbox" role="dialog" aria-modal="true" aria-label={`预览 ${previewAsset.name}`} onClick={() => setPreviewAsset(null)}><div className="lightbox-card" onClick={(event) => event.stopPropagation()}><div className="lightbox-head"><div><b>{previewAsset.name}</b><small>{previewAsset.providerStatus === "temporary" ? "临时参考" : previewAsset.purpose || previewAsset.type}</small></div><button type="button" aria-label="关闭预览" onClick={() => setPreviewAsset(null)}>×</button></div><div className={`lightbox-media ${previewAsset.type}`}><AssetVisual asset={previewAsset} large controls={previewAsset.type === "video"} /></div></div></div>}
  </main>;
}
