"use client";

import { useEffect, useRef, useState } from "react";
import { BUILTIN_TEMPLATES } from "@/lib/builtin-templates";
import type { GenerationRecord, StudioAsset } from "@/lib/types";
import { sameJsonValue, type ProviderTemplate, type ProviderSettingsStatus } from "@/lib/provider-template";

export function ProviderSettingsForm({ status, onSaved, onMessage, pendingTasks, pendingAssets }: { pendingTasks: GenerationRecord[]; pendingAssets: StudioAsset[]; status: ProviderSettingsStatus; onSaved: (status: ProviderSettingsStatus) => void; onMessage: (message: string) => void }) {
  const [template, setTemplate] = useState(status.template);
  const [endpoints, setEndpoints] = useState(status.endpoints);
  const [parameters, setParameters] = useState(status.parameters);
  const [credentials, setCredentials] = useState<Record<string, string>>({});
  const [model, setModel] = useState(status.model);
  const [busy, setBusy] = useState(false);
  const [repair, setRepair] = useState(false);
  const [verificationTasks, setVerificationTasks] = useState<Record<string, string>>({});
  const [verificationAssets, setVerificationAssets] = useState<Record<string, string>>({});
  const [feedback, setFeedback] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);
  useEffect(() => { setTemplate(status.template); setEndpoints(status.endpoints); setParameters(status.parameters); setCredentials({}); setModel(status.model); setRepair(false); }, [status.updatedAt, status.bindingId]);
  const sameDestination = sameJsonValue(template, status.template) && sameJsonValue(endpoints, status.endpoints);
  const builtinIndex = BUILTIN_TEMPLATES.findIndex(item => sameJsonValue(item, template));
  const report = (message: string) => { setFeedback(message); onMessage(message); };

  function selectTemplate(next: ProviderTemplate) {
    setTemplate(next); setEndpoints(Object.fromEntries(Object.entries(next.endpoints).map(([key, spec]) => [key, spec.defaultUrl])));
    setParameters(Object.fromEntries(Object.entries(next.parameters ?? {}).map(([key, spec]) => [key, spec.default ?? ""])));
    setCredentials({}); setModel(next.models[0].id); setRepair(false);
  }

  async function importTemplate(file?: File) {
    if (!file) return;
    setBusy(true);
    try {
      if (file.size > 131072) throw new Error("模板不能超过 128 KB。");
      const response = await fetch("/api/settings/provider/templates", { method: "POST", headers: { "Content-Type": "application/json" }, body: await file.text() });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error);
      selectTemplate(data); report(`已读取 ${data.name} 模板，请确认 API 地址并填写自己的凭证。`);
    } catch (error) { report(error instanceof Error ? error.message : "模板导入失败。"); }
    finally { setBusy(false); }
  }

  async function save() {
    setBusy(true);
    try {
      const response = await fetch("/api/settings/provider", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ template, endpoints, parameters, credentials, model, expectedBindingId: status.bindingId, repairCredentials: repair, verificationTasks, verificationAssets }) });
      const data = await response.json(); if (!response.ok) throw new Error(data.error);
      onSaved(data); setCredentials({}); report("供应商设置及独立凭证已加密保存。");
    } catch (error) { report(error instanceof Error ? error.message : "供应商设置保存失败。"); }
    finally { setBusy(false); }
  }

  async function clear() {
    if (!window.confirm("清除当前供应商凭证及模板设置？已完成作品会保留。")) return;
    setBusy(true);
    try {
      const response = await fetch("/api/settings/provider", { method: "DELETE" }); const data = await response.json();
      if (!response.ok) throw new Error(data.error);
      onSaved(data); setCredentials({}); report("供应商设置已清除，已完成作品仍然保留。");
    } catch (error) { report(error instanceof Error ? error.message : "清除设置失败。"); }
    finally { setBusy(false); }
  }

  function exportTemplate() {
    const url = URL.createObjectURL(new Blob([JSON.stringify(template, null, 2)], { type: "application/json" }));
    const link = document.createElement("a"); link.href = url; link.download = `${template.id}.json`; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  return <section className="provider-settings-form" aria-label="供应商设置">
    <div className={`settings-status ${status.configured ? "connected" : ""}`}><span>{status.configured ? "✓" : "!"}</span><div><b>{status.configured ? `${status.template.name} 已配置` : "选择视频供应商"}</b><small>生成与素材登记使用各自的凭证</small></div></div>
    {status.locked && <p className="settings-notice">有任务正在生成、登记、确认提交或保存，完成后才能更换供应商。原账户的过期凭证可在下方修复。</p>}
    <label><span>供应商模板</span><select value={builtinIndex < 0 ? "custom" : String(builtinIndex)} disabled={busy || status.locked} onChange={event => selectTemplate(BUILTIN_TEMPLATES[Number(event.target.value)])}>{BUILTIN_TEMPLATES.map((item, index) => <option key={item.id} value={index}>{item.name}</option>)}{builtinIndex < 0 && <option value="custom">{template.name}（已导入）</option>}</select></label>
    <div className="settings-actions"><button type="button" disabled={busy || status.locked} onClick={() => fileRef.current?.click()}>导入 JSON 模板</button><button type="button" onClick={exportTemplate}>导出模板</button></div>
    <input ref={fileRef} type="file" accept=".json,application/json" hidden onChange={event => { const file = event.target.files?.[0]; event.target.value = ""; void importTemplate(file); }} />
    <p className="template-caption">{template.name} · v{template.version}{template.documentationUrl && <> · <a href={template.documentationUrl} target="_blank" rel="noreferrer">供应商说明</a></>}</p>
    {(["generation", "assets"] as const).map(purpose => {
      const endpoint = template.endpoints[purpose];
      if (!endpoint) return null;
      return <fieldset className="provider-credential-group" key={purpose}><legend>{purpose === "generation" ? "视频生成" : "素材登记（可稍后填写）"}</legend>
        <label><span>{endpoint.label}</span><input type="url" value={endpoints[purpose] ?? ""} disabled={busy || status.locked} onChange={event => setEndpoints(current => ({ ...current, [purpose]: event.target.value }))} /></label>
        {Object.entries(template.credentials).filter(([, spec]) => spec.purpose === purpose).map(([key, spec]) => <label key={key}><span>{spec.label}{sameDestination && status.credentialHints[key] && <small> {status.credentialHints[key]}</small>}</span><input type="password" autoComplete="new-password" value={credentials[key] ?? ""} disabled={busy || status.locked && !repair} placeholder={sameDestination && status.credentialHints[key] ? "留空保留已保存的凭证" : "输入自己的凭证"} onChange={event => setCredentials(current => ({ ...current, [key]: event.target.value }))} /></label>)}
        {Object.entries(template.parameters ?? {}).filter(([, spec]) => spec.purpose === purpose).map(([key, spec]) => <label key={key}><span>{spec.label}{spec.required ? " *" : ""}</span><input value={parameters[key] ?? ""} disabled={busy || status.locked} onChange={event => setParameters(current => ({ ...current, [key]: event.target.value }))} /></label>)}
      </fieldset>;
    })}
    {!template.operations.registerAsset && <p className="template-caption">此模板未提供素材登记接口，可使用临时参考和已上传的文件。</p>}
    {template.id === "volcengine-ark" && <p className="template-caption">素材管理需要火山方舟账户具备相应权限，并填写已授权的素材组 ID。</p>}
    <label><span>默认模型</span><select value={model} disabled={busy || status.locked} onChange={event => setModel(event.target.value)}>{template.models.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>
    {status.locked && <label className="repair-checkbox"><input type="checkbox" checked={repair} onChange={event => setRepair(event.target.checked)} />修复原账户的过期凭证（会核对现有任务）</label>}
    {repair && pendingTasks.filter(task => !task.providerTaskId && task.status === "WAITING_PROVIDER").map(task => <label key={task.id}><span>待确认任务：{task.prompt.slice(0, 36)}</span><input value={verificationTasks[task.id] ?? ""} placeholder="供应商控制台中的任务 ID" onChange={event => setVerificationTasks(current => ({ ...current, [task.id]: event.target.value }))} /></label>)}
    {repair && pendingAssets.filter(asset => !asset.providerAssetId && asset.providerStatus === "processing").map(asset => <label key={asset.id}><span>待确认素材：{asset.name}</span><input value={verificationAssets[asset.id] ?? ""} placeholder="供应商控制台中的素材 ID" onChange={event => setVerificationAssets(current => ({ ...current, [asset.id]: event.target.value }))} /></label>)}
    <div className="settings-actions"><button type="button" className="save-key" disabled={busy || status.locked && !repair} onClick={() => void save()}>{busy ? "处理中…" : repair ? "核对并修复凭证" : "保存供应商设置"}</button>{status.persistent && <button type="button" className="clear-key" disabled={busy || status.locked} onClick={() => void clear()}>清除设置</button>}</div>
    {feedback && <p role="status" className="settings-notice">{feedback}</p>}
  </section>;
}
