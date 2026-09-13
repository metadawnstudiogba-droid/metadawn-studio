import type { AssetType, GenerationInput, StudioMode } from "./types";

export type TemplateValue = null | boolean | number | string | TemplateValue[] | { [key: string]: TemplateValue };
export type EndpointName = "generation" | "assets";
export type TemplateAuth =
  | { type: "bearer"; credential: string }
  | { type: "header"; credential: string; name: string }
  | { type: "query"; credential: string; name: string }
  | { type: "volcengine"; accessKeyId: string; secretAccessKey: string; region: string; service: string };
export interface ProviderCapabilities {
  modes: StudioMode[];
  resolutions: GenerationInput["resolution"][];
  ratios: GenerationInput["ratio"][];
  minDuration: number;
  maxDuration: number;
  maxExtendDuration?: number;
  audio: "required" | "optional" | "unsupported";
  references: Record<AssetType, number>;
}
export interface TemplateOperation {
  endpoint: EndpointName;
  method: "GET" | "POST";
  path: string;
  query?: Record<string, TemplateValue>;
  auth: TemplateAuth;
  encoding?: "json" | "form";
  body?: TemplateValue;
  response: {
    id?: string[];
    status?: string[];
    states?: Record<string, "WAITING" | "SUCCESS" | "FAILURE">;
    videoUrl?: string[];
    error?: string[];
    usage?: string[];
    failure?: { path: string; equals: TemplateValue };
  };
}
export interface ProviderTemplate {
  schemaVersion: 1;
  id: string;
  name: string;
  version: string;
  documentationUrl?: string;
  endpoints: Partial<Record<EndpointName, { label: string; defaultUrl: string }>>;
  credentials: Record<string, { label: string; purpose: EndpointName }>;
  parameters?: Record<string, { label: string; default?: string; required?: boolean; purpose: EndpointName }>;
  models: { id: string; label: string; capabilities?: Partial<ProviderCapabilities> }[];
  capabilities: ProviderCapabilities;
  operations: {
    createGeneration: TemplateOperation;
    getTask: TemplateOperation;
    registerAsset?: TemplateOperation;
    getAsset?: TemplateOperation;
  };
}
export interface ProviderSettingsInput {
  template: ProviderTemplate;
  endpoints: Partial<Record<EndpointName, string>>;
  parameters: Record<string, string>;
  credentials: Record<string, string>;
  model: string;
  expectedBindingId?: string;
  repairCredentials?: boolean;
  verificationTasks?: Record<string, string>;
  verificationAssets?: Record<string, string>;
}
export interface ProviderSettingsStatus {
  configured: boolean;
  source: "web_persistent" | "none";
  persistent: boolean;
  tokenHint: string;
  baseUrl: string;
  model: string;
  bindingId: string;
  template: ProviderTemplate;
  endpoints: Partial<Record<EndpointName, string>>;
  parameters: Record<string, string>;
  credentialHints: Record<string, string>;
  canRegisterAssets: boolean;
  locked: boolean;
  updatedAt?: string;
}

const safeKey = /^[a-zA-Z][a-zA-Z0-9_]{0,63}$/;
const forbiddenKeys = new Set(["__proto__", "prototype", "constructor"]);
const pathPattern = /^[a-zA-Z0-9_]+(?:\.[a-zA-Z0-9_]+)*$/;
const modes = ["generate", "extend", "edit", "green_screen", "white_model"];
const resolutions = ["480p", "720p", "1080p", "4k"];
const ratios = ["16:9", "9:16", "1:1", "adaptive"];

export function sameJsonValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) return Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every((item, index) => sameJsonValue(item, right[index]));
  if (!left || !right || typeof left !== "object" || typeof right !== "object") return false;
  const leftObject = left as Record<string, unknown>; const rightObject = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftObject).filter(key => leftObject[key] !== undefined).sort();
  const rightKeys = Object.keys(rightObject).filter(key => rightObject[key] !== undefined).sort();
  return leftKeys.length === rightKeys.length && leftKeys.every((key, index) => key === rightKeys[index] && sameJsonValue(leftObject[key], rightObject[key]));
}

function object(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label}必须是对象。`);
}
function text(value: unknown, label: string, max = 200): asserts value is string {
  if (typeof value !== "string" || !value.trim() || value.length > max || /[\u0000-\u001f]/.test(value)) throw new Error(`${label}无效。`);
}
function keys(value: Record<string, unknown>, allowed: string[], label: string) {
  if (Object.keys(value).some(key => forbiddenKeys.has(key) || !allowed.includes(key))) throw new Error(`${label}包含不支持的字段。`);
}
function fieldPath(value: unknown) {
  text(value, "字段路径", 200);
  if (!pathPattern.test(value) || value.split(".").some(key => forbiddenKeys.has(key))) throw new Error("字段路径无效。");
}
function enumList(value: unknown, allowed: string[], label: string) {
  if (!Array.isArray(value) || !value.length || value.length > 30 || value.some(item => !allowed.includes(item)) || new Set(value).size !== value.length) throw new Error(`${label}无效。`);
}
function capabilities(value: unknown, partial = false) {
  object(value, "功能范围");
  keys(value, ["modes", "resolutions", "ratios", "minDuration", "maxDuration", "maxExtendDuration", "audio", "references"], "功能范围");
  for (const [key, allowed] of [["modes", modes], ["resolutions", resolutions], ["ratios", ratios]] as const) {
    if (!partial || value[key] !== undefined) enumList(value[key], [...allowed], key);
  }
  for (const key of ["minDuration", "maxDuration", "maxExtendDuration"]) {
    if (partial && value[key] === undefined || key === "maxExtendDuration" && value[key] === undefined) continue;
    if (!Number.isInteger(value[key]) || Number(value[key]) < 1 || Number(value[key]) > 180) throw new Error("模板时长范围必须为 1–180 秒。");
  }
  if ((!partial || value.audio !== undefined) && !["required", "optional", "unsupported"].includes(String(value.audio))) throw new Error("音频功能声明无效。");
  if (!partial || value.references !== undefined) {
    object(value.references, "参考数量");
    keys(value.references, ["image", "video", "audio"], "参考数量");
    for (const [kind, max] of [["image", 30], ["video", 10], ["audio", 10]] as const) {
      if (!Number.isInteger(value.references[kind]) || Number(value.references[kind]) < 0 || Number(value.references[kind]) > max) throw new Error("参考数量超过工作台支持范围。");
    }
  }
}

export function validateEndpointUrl(value: unknown): string {
  text(value, "API 地址", 1000);
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.port && url.port !== "443") throw new Error("API 地址必须是无凭证、查询参数的 HTTPS 地址，端口为 443。");
  return url.toString().replace(/\/$/, "");
}

function validateValue(value: unknown, depth = 0, counter = { nodes: 0 }): void {
  if (++counter.nodes > 4000 || depth > 20) throw new Error("模板内容过于复杂。");
  if (value === null || typeof value === "boolean" || typeof value === "number" && Number.isFinite(value)) return;
  if (typeof value === "string") { if (value.length > 16000) throw new Error("模板文字过长。"); return; }
  if (Array.isArray(value)) { for (const child of value) validateValue(child, depth + 1, counter); return; }
  object(value, "模板值");
  if (Object.keys(value).some(key => forbiddenKeys.has(key))) throw new Error("模板包含禁止的字段。");
  const operators = Object.keys(value).filter(key => key.startsWith("$"));
  if (operators.length) {
    if ("$ref" in value) { keys(value, ["$ref"], "引用表达式"); fieldPath(value.$ref); }
    else if ("$map" in value) { keys(value, ["$map", "value"], "映射表达式"); fieldPath(value.$map); if (!("value" in value)) throw new Error("映射缺少 value。"); }
    else if ("$lookup" in value) { keys(value, ["$lookup", "values", "default"], "枚举映射"); object(value.values, "枚举映射 values"); }
    else if ("$string" in value) { keys(value, ["$string"], "文字表达式"); text(value.$string, "文字表达式", 16000); for (const match of value.$string.matchAll(/\{\{([^}]+)\}\}/g)) fieldPath(match[1]); }
    else throw new Error("模板包含不支持的表达式；不允许执行脚本。");
  }
  for (const child of Object.values(value)) validateValue(child, depth + 1, counter);
}

export function validateProviderTemplate(input: unknown): ProviderTemplate {
  if (JSON.stringify(input)?.length > 128_000) throw new Error("模板不得超过 128 KB。");
  object(input, "模板");
  keys(input, ["schemaVersion", "id", "name", "version", "documentationUrl", "endpoints", "credentials", "parameters", "models", "capabilities", "operations"], "模板");
  if (input.schemaVersion !== 1) throw new Error("不支持此模板版本；当前支持 schemaVersion 1。");
  text(input.id, "模板 ID", 64); if (!/^[a-z0-9][a-z0-9._-]*$/.test(input.id)) throw new Error("模板 ID 无效。");
  text(input.name, "模板名称", 80); text(input.version, "模板版本", 32);
  if (input.documentationUrl !== undefined) { const url = new URL(String(input.documentationUrl)); if (url.protocol !== "https:" || url.username || url.password) throw new Error("文档链接必须使用 HTTPS。"); }
  object(input.endpoints, "接口地址"); keys(input.endpoints, ["generation", "assets"], "接口地址");
  if (!input.endpoints.generation) throw new Error("模板缺少生成接口。");
  for (const endpoint of Object.values(input.endpoints)) { object(endpoint, "接口"); keys(endpoint, ["label", "defaultUrl"], "接口"); text(endpoint.label, "接口名称"); validateEndpointUrl(endpoint.defaultUrl); }
  object(input.credentials, "凭证声明");
  if (Object.keys(input.credentials).length > 12) throw new Error("凭证字段过多。");
  for (const [key, field] of Object.entries(input.credentials)) {
    if (!safeKey.test(key) || forbiddenKeys.has(key)) throw new Error("凭证名称无效。");
    object(field, "凭证字段"); keys(field, ["label", "purpose"], "凭证字段"); text(field.label, "凭证标签");
    if (!["generation", "assets"].includes(String(field.purpose))) throw new Error("凭证用途无效。");
  }
  if (input.parameters !== undefined) {
    object(input.parameters, "参数声明"); if (Object.keys(input.parameters).length > 20) throw new Error("参数字段过多。");
    for (const [key, field] of Object.entries(input.parameters)) {
      if (!safeKey.test(key) || forbiddenKeys.has(key)) throw new Error("参数名称无效。");
      object(field, "参数字段"); keys(field, ["label", "default", "required", "purpose"], "参数字段"); text(field.label, "参数标签");
      if (field.default !== undefined && (typeof field.default !== "string" || field.default.length > 2000)) throw new Error("参数默认值无效。");
      if (field.required !== undefined && typeof field.required !== "boolean" || !["generation", "assets"].includes(String(field.purpose))) throw new Error("参数声明无效。");
    }
  }
  capabilities(input.capabilities);
  if (!Array.isArray(input.models) || !input.models.length || input.models.length > 30) throw new Error("模板必须声明 1–30 个模型。");
  const modelIds = new Set();
  for (const model of input.models) {
    object(model, "模型"); keys(model, ["id", "label", "capabilities"], "模型"); text(model.id, "模型 ID"); text(model.label, "模型名称", 80);
    if (modelIds.has(model.id)) throw new Error("模型 ID 重复。"); modelIds.add(model.id);
    if (model.capabilities) capabilities(model.capabilities, true);
  }
  object(input.operations, "接口操作"); keys(input.operations, ["createGeneration", "getTask", "registerAsset", "getAsset"], "接口操作");
  if (!input.operations.createGeneration || !input.operations.getTask) throw new Error("模板必须提供提交任务及查询任务接口。");
  if (Boolean(input.operations.registerAsset) !== Boolean(input.operations.getAsset)) throw new Error("素材登记与状态查询接口必须成对声明。");
  for (const [name, operation] of Object.entries(input.operations)) {
    object(operation, "接口操作"); keys(operation, ["endpoint", "method", "path", "query", "auth", "encoding", "body", "response"], "接口操作");
    const purpose = name === "createGeneration" || name === "getTask" ? "generation" : "assets";
    if (operation.endpoint !== purpose || !input.endpoints[purpose]) throw new Error("接口必须使用其声明用途的地址。");
    if (!["GET", "POST"].includes(String(operation.method))) throw new Error("模板仅支持 GET、POST 请求。");
    text(operation.path, "接口路径", 1000);
    if (!operation.path.startsWith("/") || operation.path.startsWith("//") || /[\\?#]|(?:^|\/)\.\.(?:\/|$)/.test(operation.path)) throw new Error("接口路径必须为相对 API 地址的绝对路径。");
    for (const match of operation.path.matchAll(/\{([^}]+)\}/g)) fieldPath(match[1]);
    if (operation.encoding !== undefined && !["json", "form"].includes(String(operation.encoding))) throw new Error("模板请求体编码无效。");
    object(operation.auth, "鉴权");
    const auth = operation.auth;
    const credentialNames = auth.type === "volcengine" ? [auth.accessKeyId, auth.secretAccessKey] : [auth.credential];
    if (!credentialNames.every(key => typeof key === "string" && (input.credentials as Record<string, { purpose: string }>)[key]?.purpose === purpose)) throw new Error("接口只能使用其用途下声明的凭证。");
    if (auth.type === "volcengine") {
      keys(auth, ["type", "accessKeyId", "secretAccessKey", "region", "service"], "签名鉴权");
      for (const value of [auth.region, auth.service]) { text(value, "签名范围", 80); if (!/^[a-z0-9-]+$/.test(value)) throw new Error("签名范围无效。"); }
    } else if (auth.type === "bearer") keys(auth, ["type", "credential"], "Bearer 鉴权");
    else if (auth.type === "header" || auth.type === "query") {
      keys(auth, ["type", "credential", "name"], "自定义鉴权"); text(auth.name, "鉴权字段", 80);
      if (!/^[a-zA-Z0-9_-]+$/.test(auth.name) || /^(host|cookie|proxy-authorization|connection|content-length|transfer-encoding|forwarded|x-forwarded-.+)$/i.test(auth.name)) throw new Error("鉴权字段禁止使用此名称。");
    } else throw new Error("模板鉴权方式不受支持。");
    if (operation.body !== undefined) validateValue(operation.body);
    if (operation.query !== undefined) { object(operation.query, "查询参数"); validateValue(operation.query); }
    object(operation.response, "响应映射"); keys(operation.response, ["id", "status", "states", "videoUrl", "error", "usage", "failure"], "响应映射");
    for (const key of ["id", "status", "videoUrl", "error", "usage"]) {
      const value = operation.response[key]; if (value === undefined) continue;
      if (!Array.isArray(value) || !value.length || value.length > 8) throw new Error("响应映射必须是字段路径数组。");
      for (const path of value) fieldPath(path);
    }
    if ((name === "createGeneration" || name === "registerAsset") && !operation.response.id) throw new Error("提交接口必须声明结果 ID 路径。");
    if (name === "getAsset" && !operation.response.status) throw new Error("查询素材必须声明状态路径。");
    if ((name === "getTask" || name === "getAsset") && (!operation.response.states || !Object.values(operation.response.states).includes("SUCCESS"))) throw new Error("查询接口必须声明成功状态映射。");
    if (name === "getTask" && (!operation.response.status || !operation.response.videoUrl)) throw new Error("查询任务必须声明状态及视频地址路径。");
    if (operation.response.states !== undefined) {
      object(operation.response.states, "状态映射");
      if (Object.entries(operation.response.states).some(([key, value]) => forbiddenKeys.has(key) || !["WAITING", "SUCCESS", "FAILURE"].includes(String(value)))) throw new Error("状态映射无效。");
    }
    if (operation.response.failure !== undefined) { object(operation.response.failure, "失败条件"); keys(operation.response.failure, ["path", "equals"], "失败条件"); fieldPath(operation.response.failure.path); validateValue(operation.response.failure.equals); }
  }
  const result = JSON.parse(JSON.stringify(input)) as ProviderTemplate;
  for (const model of result.models) capabilitiesFor(result, model.id);
  return result;
}

export function capabilitiesFor(template: ProviderTemplate, model: string): ProviderCapabilities {
  const result = { ...template.capabilities, ...template.models.find(item => item.id === model)?.capabilities };
  if (result.minDuration > result.maxDuration) throw new Error("模板时长范围无效。");
  return result;
}

export function readPath(value: unknown, path: string): unknown {
  fieldPath(path);
  return path.split(".").reduce<unknown>((current, key) => current !== null && typeof current === "object" && Object.hasOwn(current, key) ? (current as Record<string, unknown>)[key] : undefined, value);
}
export function evaluateTemplate(value: TemplateValue, context: Record<string, unknown>, depth = 0, budget = { nodes: 0 }): unknown {
  if (++budget.nodes > 10000) throw new Error("模板执行超过复杂度限制。");
  if (depth > 24) throw new Error("模板嵌套过深。");
  if (Array.isArray(value)) return value.map(item => evaluateTemplate(item, context, depth + 1, budget));
  if (value === null || typeof value !== "object") return value;
  if (typeof value.$ref === "string") return readPath(context, value.$ref);
  if (typeof value.$string === "string") return value.$string.replace(/\{\{([^}]+)\}\}/g, (_, path: string) => {
    const resolved = readPath(context, path); if (resolved === undefined || typeof resolved === "object") throw new Error("文字表达式引用缺少值或不是文字。"); return String(resolved);
  });
  if (typeof value.$map === "string") {
    const array = readPath(context, value.$map);
    if (!Array.isArray(array) || array.length > 100) throw new Error("映射表达式需要最多 100 个元素的数组。");
    return array.map(item => evaluateTemplate(value.value, { ...context, item }, depth + 1, budget));
  }
  if ("$lookup" in value) {
    const key = String(evaluateTemplate(value.$lookup, context, depth + 1, budget));
    const table = value.values as Record<string, TemplateValue>;
    return Object.hasOwn(table, key) ? evaluateTemplate(table[key], context, depth + 1, budget) : value.default === undefined ? undefined : evaluateTemplate(value.default, context, depth + 1, budget);
  }
  return Object.fromEntries(Object.entries(value).flatMap(([key, child]) => {
    const result = evaluateTemplate(child, context, depth + 1, budget); return result === undefined ? [] : [[key, result]];
  }));
}
