import { AwsClient } from "aws4fetch";
import { decryptSecret, encryptSecret } from "./secrets";
import { store, type StorageJurisdiction, type StorageSettingsRow, type StorageState } from "./store";
import type { GenerationRecord, StudioAsset } from "./types";
import { HttpError } from "./http-error";
import { safeFetch } from "./safe-http";

const UPLOAD_TTL = 15 * 60;
const READ_TTL = 5 * 60;
const PROVIDER_TTL = 6 * 60 * 60;
export const MAX_DIRECT_UPLOAD_BYTES = 5 * 1024 * 1024 * 1024;
export type R2Credentials = { accessKeyId: string; secretAccessKey: string };
export type R2Config = R2Credentials & { accountId: string; bucket: string; jurisdiction: StorageJurisdiction; namespace: string };

function endpoint(config: Pick<R2Config, "accountId" | "jurisdiction">) {
  const suffix = config.jurisdiction === "default" ? "" : `.${config.jurisdiction}`;
  return `https://${config.accountId}${suffix}.r2.cloudflarestorage.com`;
}
function r2Client(config: R2Config) { return new AwsClient({ accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey, service: "s3", region: "auto" }); }
function encodeKey(key: string) { return key.split("/").map(encodeURIComponent).join("/"); }
function objectUrl(config: R2Config, key: string) { return `${endpoint(config)}/${encodeURIComponent(config.bucket)}/${encodeKey(key)}`; }
async function sign(config: R2Config, key: string, method: "GET" | "PUT" | "HEAD" | "DELETE", expiresIn: number, contentType?: string, contentLength?: number) {
  const url = new URL(objectUrl(config, key)); url.searchParams.set("X-Amz-Expires", String(Math.min(604800, Math.max(1, expiresIn))));
  const headers = new Headers();
  if (contentType) headers.set("Content-Type", contentType);
  if (contentLength !== undefined) headers.set("Content-Length", String(contentLength));
  const hasSignedHeaders = Boolean(contentType) || contentLength !== undefined;
  return (await r2Client(config).sign(new Request(url, { method, headers: hasSignedHeaders ? headers : undefined }), { aws: { signQuery: true, allHeaders: hasSignedHeaders } })).url;
}
function validAccountId(value: string) { return /^[a-f0-9]{32}$/i.test(value); }
function validBucket(value: string) { return /^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])?$/.test(value); }
function safeFilename(name: string) { return name.normalize("NFKC").replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(-120) || "asset"; }
function isManagedKey(config: R2Config, key: string) { return key.startsWith(`seedance/${config.namespace}/`) || key.startsWith("assets/") || key.startsWith("generations/"); }
function storageAad(userId: string) { return `r2:${userId}:v1`; }

export function parseR2Uri(value: string) { if (!value.startsWith("r2://")) return undefined; const url = new URL(value); return { bucket: url.hostname, key: url.pathname.replace(/^\//, "").split("/").map(decodeURIComponent).join("/") }; }
export function toR2Uri(config: R2Config, objectKey: string) { return `r2://${config.bucket}/${objectKey}`; }

function configFromRow(row: StorageSettingsRow): R2Config {
  if (!row.encryptedCredentials) throw new Error("Cloudflare R2 已断开，请重新连接。");
  const credentials = JSON.parse(decryptSecret(row.encryptedCredentials, storageAad(row.userId))) as R2Credentials;
  return { accountId: row.accountId, bucket: row.bucket, jurisdiction: row.jurisdiction, namespace: row.namespace, ...credentials };
}

export async function getUserStorageConfig(userId: string, requireConnected = true) {
  const row = await store.getStorageSettingsRow(userId);
  if (!row || !row.encryptedCredentials) throw new Error("请先连接自己的 Cloudflare R2 Bucket。");
  if (requireConnected && row.state !== "connected") throw new Error(row.state === "needs_cors" ? "请先完成 R2 CORS 浏览器验证。" : "Cloudflare R2 需要重新连接。");
  return { row, config: configFromRow(row) };
}

async function probe(config: R2Config, requireEmpty: boolean) {
  const root = await fetch(await sign(config, "", "GET", 60), { method: "GET", cache: "no-store" });
  const listing = await root.text();
  if (!root.ok) throw new Error(`R2 凭据验证失败（${root.status}）。请确认使用指定 Bucket 的 Object Read & Write token。`);
  if (requireEmpty && /<Key>[^<]+<\/Key>/.test(listing)) throw new Error("请连接一个专用且空白的 R2 Bucket。");
  const checkKey = `seedance/${config.namespace}/.probe-${crypto.randomUUID()}`;
  const content = "ok";
  const put = await fetch(await sign(config, checkKey, "PUT", 60, "text/plain"), { method: "PUT", headers: { "Content-Type": "text/plain" }, body: content, cache: "no-store" });
  const head = await fetch(await sign(config, checkKey, "HEAD", 60), { method: "HEAD", cache: "no-store" });
  const get = await fetch(await sign(config, checkKey, "GET", 60), { method: "GET", cache: "no-store" });
  const removed = await fetch(await sign(config, checkKey, "DELETE", 60), { method: "DELETE", cache: "no-store" });
  if (!put.ok || !head.ok || !get.ok || !removed.ok) throw new Error("R2 需要 Object Read & Write 权限，连接未保存。");
}

export async function saveUserStorageSettings(userId: string, input: { accountId: string; bucket: string; jurisdiction: StorageJurisdiction; accessKeyId: string; secretAccessKey: string }) {
  if (!["default", "eu", "us"].includes(input.jurisdiction)) throw new HttpError(400, "第一版暂不开放此 R2 jurisdiction。");
  const accountId = input.accountId.trim(); const bucket = input.bucket.trim();
  if (!validAccountId(accountId) || !validBucket(bucket) || !input.accessKeyId.trim() || !input.secretAccessKey.trim()) throw new Error("R2 设置格式无效，请检查 Account ID、Bucket 和 S3 凭据。");
  const current = await store.getStorageSettingsRow(userId);
  const hasContent = (await store.listAssets(userId)).length + (await store.listGenerations(userId)).length > 0;
  if (hasContent && !current) throw new Error("工作区已有内容但缺少原 Bucket 身份，请先完成管理员数据迁移。");
  const changedBucket = current && (current.accountId !== accountId || current.bucket !== bucket || current.jurisdiction !== input.jurisdiction);
  if (hasContent && changedBucket) throw new HttpError(409, "已有素材或作品时不能更换 Bucket；请先清空工作区。");
  const namespace = current?.namespace || crypto.randomUUID();
  const config: R2Config = { accountId, bucket, jurisdiction: input.jurisdiction, accessKeyId: input.accessKeyId.trim(), secretAccessKey: input.secretAccessKey.trim(), namespace };
  await probe(config, !current);
  const row: StorageSettingsRow = { userId, accountId, bucket, jurisdiction: input.jurisdiction, encryptedCredentials: encryptSecret(JSON.stringify({ accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey }), storageAad(userId)), namespace, state: "needs_cors", verifiedAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  try { await store.saveStorageSettingsRow(row); }
  catch (error) {
    if ((error as { code?: string }).code === "23505") throw new HttpError(409, "无法连接此 R2 Bucket，请检查设置或联系支持。");
    throw error;
  }
  return getStorageStatus(userId);
}

export async function createCorsProbe(userId: string) {
  const { config } = await getUserStorageConfig(userId, false);
  const objectKey = `seedance/${config.namespace}/.cors-${crypto.randomUUID()}`;
  return { objectKey, uploadUrl: await sign(config, objectKey, "PUT", 300, "text/plain"), headUrl: await sign(config, objectKey, "HEAD", 300), expiresIn: 300 };
}
export async function verifyCorsProbe(userId: string, objectKey: string) {
  const { config } = await getUserStorageConfig(userId, false);
  if (!objectKey.startsWith(`seedance/${config.namespace}/.cors-`)) throw new Error("CORS 验证对象无效。");
  const response = await fetch(await sign(config, objectKey, "HEAD", 60), { method: "HEAD", cache: "no-store" });
  if (!response.ok) throw new Error("浏览器未能写入 R2。请按说明配置 CORS 后重试。");
  await fetch(await sign(config, objectKey, "DELETE", 60), { method: "DELETE", cache: "no-store" });
  await store.updateStorageState(userId, "connected"); return getStorageStatus(userId);
}
export async function disconnectUserStorage(userId: string) { const active = await store.countActiveGenerations(userId); if (active) throw new Error("仍有生成任务，暂时不能断开 R2。"); await store.disconnectStorage(userId); return getStorageStatus(userId); }
export async function getStorageStatus(userId: string) {
  const row = await store.getStorageSettingsRow(userId);
  if (!row) return { configured: false, provider: "Cloudflare R2", state: "disconnected" as StorageState, private: true };
  let accessKeyHint = "";
  try { if (row.encryptedCredentials) accessKeyHint = `•••• ${configFromRow(row).accessKeyId.slice(-4)}`; } catch { /* stale ciphertext is never exposed */ }
  return { configured: row.state === "connected", provider: "Cloudflare R2", state: row.state, bucket: row.bucket, accountId: `•••• ${row.accountId.slice(-4)}`, jurisdiction: row.jurisdiction, accessKeyHint, private: true, verifiedAt: row.verifiedAt, namespace: undefined };
}

export function makeAssetObjectKey(config: R2Config, filename: string) { return `seedance/${config.namespace}/assets/${new Date().toISOString().slice(0, 10)}/${crypto.randomUUID()}-${safeFilename(filename)}`; }
type UploadReceipt = { objectKey: string; size: number; contentType: string; expiresAt: number; accountId: string; bucket: string; jurisdiction: StorageJurisdiction; namespace: string };
export async function createPresignedAssetUpload(config: R2Config, input: { filename: string; contentType: string; size: number }, userId: string) {
  if (!userId.trim() || !input.filename.trim() || !/^[\w.+-]+\/[\w.+-]+$/.test(input.contentType) || !Number.isSafeInteger(input.size) || input.size < 1 || input.size > MAX_DIRECT_UPLOAD_BYTES) throw new Error("上传文件无效或超过 5 GiB 限制。");
  const objectKey = makeAssetObjectKey(config, input.filename);
  const receipt: UploadReceipt = { objectKey, size: input.size, contentType: input.contentType, expiresAt: Date.now() + UPLOAD_TTL * 1000, accountId: config.accountId, bucket: config.bucket, jurisdiction: config.jurisdiction, namespace: config.namespace };
  return { objectKey, uploadUrl: await sign(config, objectKey, "PUT", UPLOAD_TTL, input.contentType), uploadReceipt: encryptSecret(JSON.stringify(receipt), `asset-upload:${userId}:v1`), expiresIn: UPLOAD_TTL };
}
export async function assertR2ObjectExists(config: R2Config, objectKey: string, uploadReceipt: unknown, userId: string, type: StudioAsset["type"]) {
  let receipt: UploadReceipt;
  try {
    if (typeof uploadReceipt !== "string" || uploadReceipt.length > 4096) throw new Error();
    receipt = JSON.parse(decryptSecret(uploadReceipt, `asset-upload:${userId}:v1`));
    if (!receipt || receipt.objectKey !== objectKey || !objectKey.startsWith(`seedance/${config.namespace}/assets/`) || receipt.accountId !== config.accountId || receipt.bucket !== config.bucket || receipt.jurisdiction !== config.jurisdiction || receipt.namespace !== config.namespace || !Number.isSafeInteger(receipt.expiresAt) || receipt.expiresAt <= Date.now() || !Number.isSafeInteger(receipt.size) || receipt.size < 1 || receipt.size > MAX_DIRECT_UPLOAD_BYTES || !receipt.contentType.startsWith(`${type}/`)) throw new Error();
  } catch { throw new HttpError(400, "上传凭证无效或已过期，请重新上传。"); }
  const response = await fetch(await sign(config, objectKey, "HEAD", 60), { method: "HEAD", cache: "no-store" });
  if (!response.ok) throw new HttpError(400, "R2 中找不到刚上传的素材，请重新上传。");
  if (response.headers.get("content-length") !== String(receipt.size) || response.headers.get("content-type") !== receipt.contentType) throw new HttpError(400, "R2 文件大小或类型与上传请求不一致，未保存素材。");
}
function storedKey(config: R2Config, value: string) { const parsed = parseR2Uri(value); if (!parsed) return undefined; if (parsed.bucket !== config.bucket || !isManagedKey(config, parsed.key)) throw new Error("R2 对象不属于当前工作区。"); return parsed.key; }
export async function deleteStoredAsset(config: R2Config, value: string) { const objectKey = storedKey(config, value); if (!objectKey) return false; if (!objectKey.includes("/assets/") && !objectKey.startsWith("assets/")) throw new Error("仅允许删除 R2 素材对象。"); const response = await fetch(await sign(config, objectKey, "DELETE", 60), { method: "DELETE", cache: "no-store" }); if (!response.ok && response.status !== 404) throw new Error(`Cloudflare R2 删除失败（${response.status}）。`); return true; }
export async function deleteStoredGeneration(config: R2Config, value: string) { const objectKey = storedKey(config, value); if (!objectKey) return false; if (!objectKey.includes("/generations/") && !objectKey.startsWith("generations/")) throw new Error("仅允许删除 R2 成品对象。"); const response = await fetch(await sign(config, objectKey, "DELETE", 60), { method: "DELETE", cache: "no-store" }); if (!response.ok && response.status !== 404) throw new Error(`Cloudflare R2 删除失败（${response.status}）。`); return true; }
export async function resolveStoredUrl(config: R2Config, value: string, expiresIn = READ_TTL) { const objectKey = storedKey(config, value); return objectKey ? sign(config, objectKey, "GET", expiresIn) : value; }
export async function resolveProviderUrl(config: R2Config, value: string) { const objectKey = storedKey(config, value); return objectKey ? sign(config, objectKey, "GET", PROVIDER_TTL) : value; }
export async function presentAsset(config: R2Config, asset: StudioAsset) { return { ...asset, sourceUrl: await resolveStoredUrl(config, asset.sourceUrl) }; }
export async function presentGeneration(config: R2Config, generation: GenerationRecord) { return { ...generation, savedVideoUrl: generation.savedVideoUrl ? await resolveStoredUrl(config, generation.savedVideoUrl) : undefined, providerVideoUrl: undefined }; }
export async function mirrorRemoteVideo(config: R2Config, url: string, id: string) {
  const response = await safeFetch(url, { headers: { "Accept-Encoding": "identity" }, signal: AbortSignal.timeout(12 * 60_000) });
  if (!response.ok || !response.body || !response.headers.get("content-type")?.startsWith("video/")) { await response.body?.cancel(); throw new Error("无法读取供应商生成的视频以进行归档。"); }
  const sourceLength = response.headers.get("content-length");
  if (!sourceLength || !/^\d+$/.test(sourceLength) || !Number.isSafeInteger(Number(sourceLength)) || Number(sourceLength) < 1) { await response.body.cancel(); throw new Error("供应商视频缺少有效的 Content-Length，无法安全归档。"); }
  const expectedBytes = Number(sourceLength);
  if (expectedBytes > MAX_DIRECT_UPLOAD_BYTES) { await response.body.cancel(); throw new Error("供应商视频超过 5 GiB 限制。"); }
  const objectKey = `seedance/${config.namespace}/generations/${id}.mp4`;
  const contentType = response.headers.get("content-type")!;
  let bytes = 0;
  const countedBody = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      bytes += chunk.byteLength;
      if (bytes > MAX_DIRECT_UPLOAD_BYTES) throw new Error("供应商视频超过 5 GiB 限制。");
      controller.enqueue(chunk);
    },
    flush() {
      if (bytes !== expectedBytes) throw new Error("供应商视频长度不完整。");
    },
  }));
  const uploaded = await fetch(await sign(config, objectKey, "PUT", UPLOAD_TTL, contentType, expectedBytes), { method: "PUT", headers: { "Content-Type": contentType, "Content-Length": String(expectedBytes) }, body: countedBody, duplex: "half", signal: AbortSignal.timeout(12 * 60_000) } as RequestInit & { duplex: "half" });
  if (!uploaded.ok) throw new Error(`成品归档到 R2 失败（${uploaded.status}）。`);
  const head = await fetch(await sign(config, objectKey, "HEAD", 60), { method: "HEAD", cache: "no-store" });
  if (!head.ok || !bytes || head.headers.get("content-length") !== String(bytes) || head.headers.get("content-type") !== contentType) throw new Error("R2 未确认成品完整归档。");
  return toR2Uri(config, objectKey);
}
