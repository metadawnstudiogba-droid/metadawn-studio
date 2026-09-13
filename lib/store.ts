import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { Pool, type QueryConfig, type QueryResultRow } from "pg";
import type { GenerationRecord, StudioAsset, TaskStatus } from "./types";
import { HttpError } from "./http-error";
import type { ProviderTemplate } from "./provider-template";
import { isLocalMode, LOCAL_USER_ID } from "./runtime-mode";
import type { PGlite } from "@electric-sql/pglite";
type TenantClient = { query<R extends QueryResultRow = QueryResultRow>(sql: string, values?: unknown[]): Promise<{ rows: R[]; rowCount: number | null }> };

export type StorageJurisdiction = "default" | "eu" | "us" | "fedramp";
export type StorageState = "disconnected" | "needs_cors" | "connected" | "needs_reconnect" | "degraded";
export type StorageSettingsRow = { userId: string; accountId: string; bucket: string; jurisdiction: StorageJurisdiction; encryptedCredentials: string | null; namespace: string; state: StorageState; verifiedAt?: string; updatedAt: string };

export type ProviderSettingsRow = { encryptedToken: string; baseUrl: string; model: string; updatedAt: string; adapterConfig?: { template: ProviderTemplate; endpoints: Partial<Record<"generation" | "assets", string>>; parameters: Record<string, string> }; encryptedCredentials?: string; providerBindingId?: string };
const pendingStatuses: TaskStatus[] = ["WAITING_PROVIDER", "ARCHIVING", "STORAGE_ERROR"];
const providerBusyMessage = "仍有生成、待确认提交、素材登记或待归档任务，请完成处理后再更换供应商设置。";
const memory = { assets: new Map<string, StudioAsset>(), generations: new Map<string, GenerationRecord>(), providerSettings: new Map<string, ProviderSettingsRow>(), storageSettings: new Map<string, StorageSettingsRow>(), archiveLeases: new Map<string, number>() };
let pool: Pool | undefined;

function db() {
  const url = process.env.DATABASE_URL;
  if (url) return pool ??= new Pool({ connectionString: url });
  if (process.env.NODE_ENV === "test") return undefined;
  throw new Error("缺少 DATABASE_URL，无法访问工作区数据。");
}
function useMemoryStore() { return !isLocalMode() && !db(); }
function key(userId: string, id: string) { return `${userId}:${id}`; }
async function withTenant<T>(userId: string, query: (client: TenantClient) => Promise<T>, statementTimeoutMs?: number) {
  if (typeof userId !== "string" || !userId.trim()) throw new Error("缺少工作区用户。");
  if (isLocalMode()) {
    if (userId !== LOCAL_USER_ID) throw new Error("本地模式只能访问当前本地工作区。");
    const database = (await (await import("./local-runtime.mjs")).getLocalDatabase()).database as PGlite;
    return database.transaction(async transaction => {
      await transaction.query("SET LOCAL ROLE seedance_runtime");
      await transaction.query("SELECT set_config('app.user_id', $1, true)", [userId]);
      if (statementTimeoutMs !== undefined) await transaction.query("SELECT set_config('statement_timeout', $1, true)", [String(Math.max(1, statementTimeoutMs))]);
      const client: TenantClient = { query: async <R extends QueryResultRow>(sql: string, values?: unknown[]) => {
        const result = await transaction.query<R>(sql, values);
        return { rows: result.rows, rowCount: result.rows.length || result.affectedRows || 0 };
      } };
      return query(client);
    });
  }
  const connection = db();
  if (!connection) throw new Error("测试内存存储不能执行 SQL 查询。");
  const client = await connection.connect();
  let discard = false;
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.user_id', $1, true)", [userId]);
    if (statementTimeoutMs !== undefined) await client.query("SELECT set_config('statement_timeout', $1, true)", [String(Math.max(1, statementTimeoutMs))]);
    const value = await query(client);
    await client.query("COMMIT");
    return value;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => { discard = true; });
    throw error;
  } finally { client.release(discard); }
}

function assetFromRow(row: Record<string, unknown>): StudioAsset { return { id: row.id as string, name: row.name as string, type: row.type as StudioAsset["type"], purpose: row.purpose as string, sourceUrl: row.source_url as string, providerAssetId: row.provider_asset_id as string | undefined, providerBindingId: row.provider_binding_id as string | undefined, registrationStartedAt: row.registration_started_at ? new Date(row.registration_started_at as string).toISOString() : undefined, providerStatus: row.provider_status as StudioAsset["providerStatus"], createdAt: new Date(row.created_at as string).toISOString() }; }
function generationFromRow(row: Record<string, unknown>): GenerationRecord { return { id: row.id as string, providerTaskId: row.provider_task_id as string | undefined, providerBindingId: row.provider_binding_id as string | undefined, providerSnapshot: row.provider_snapshot as GenerationRecord["providerSnapshot"], mode: row.mode as GenerationRecord["mode"], model: row.model as string, prompt: row.prompt as string, input: row.request_json as GenerationRecord["input"], status: row.status as TaskStatus, parentGenerationId: row.parent_generation_id as string | undefined, savedVideoUrl: row.saved_video_url as string | undefined, errorMessage: row.error_message as string | undefined, usage: row.usage_json as Record<string, unknown> | undefined, createdAt: new Date(row.created_at as string).toISOString(), updatedAt: new Date(row.updated_at as string).toISOString() }; }
function storageFromRow(row: Record<string, unknown>): StorageSettingsRow { return { userId: row.user_id as string, accountId: row.account_id as string, bucket: row.bucket as string, jurisdiction: row.jurisdiction as StorageJurisdiction, encryptedCredentials: row.encrypted_credentials as string | null, namespace: row.namespace as string, state: row.state as StorageState, verifiedAt: row.verified_at ? new Date(row.verified_at as string).toISOString() : undefined, updatedAt: new Date(row.updated_at as string).toISOString() }; }
const active: TaskStatus[] = ["WAITING_PROVIDER", "ARCHIVING"];

function assertConfirmationAge(value: string) {
  if (!Number.isFinite(Date.parse(value)) || Date.now() - Date.parse(value) < 120000) throw new HttpError(409, "提交后请等待 2 分钟，再核对并处理结果。");
}
function assertRemoteId(value: string) { if (typeof value !== "string" || !value.trim() || value.length > 512) throw new HttpError(400, "供应商 ID 无效。"); }
export function providerRowRevision(row?: ProviderSettingsRow) {
  return row ? createHash("sha256").update(JSON.stringify([row.encryptedToken, row.encryptedCredentials, row.providerBindingId, row.adapterConfig, row.model])).digest("hex") : undefined;
}
function providerFromRow(row: Record<string, unknown>): ProviderSettingsRow {
  return { encryptedToken: row.encrypted_token as string, baseUrl: row.base_url as string, model: row.model as string, updatedAt: new Date(row.updated_at as string).toISOString(), adapterConfig: row.adapter_config as ProviderSettingsRow["adapterConfig"], encryptedCredentials: row.encrypted_credentials as string | undefined, providerBindingId: row.provider_binding_id as string | undefined };
}
function memoryProviderBusy(userId: string) {
  return [...memory.generations.entries()].some(([id, g]) => id.startsWith(`${userId}:`) && pendingStatuses.includes(g.status)) || [...memory.assets.entries()].some(([id, a]) => id.startsWith(`${userId}:`) && a.providerStatus === "processing");
}
async function lockProvider(client: TenantClient, userId: string) {
  await client.query('SELECT id FROM public."user" WHERE id=$1 FOR UPDATE', [userId]);
}
async function sqlProviderBusy(client: TenantClient, userId: string) {
  const result = await client.query("SELECT EXISTS(SELECT 1 FROM studio_generations WHERE user_id=$1 AND status=ANY($2)) OR EXISTS(SELECT 1 FROM studio_assets WHERE user_id=$1 AND provider_status='processing') AS busy", [userId, pendingStatuses]);
  return Boolean(result.rows[0].busy);
}
async function assertBinding(client: TenantClient, userId: string, bindingId?: string) {
  if (!bindingId) return;
  const result = await client.query("SELECT provider_binding_id FROM studio_provider_settings WHERE user_id=$1", [userId]);
  if (!result.rowCount || (result.rows[0].provider_binding_id ?? `legacy:${userId}`) !== bindingId) throw new HttpError(409, "供应商设置已改变，请刷新后重新提交。");
}
function assertMemoryBinding(userId: string, bindingId?: string) {
  if (!bindingId) return;
  const row = memory.providerSettings.get(userId);
  if (!row || (row.providerBindingId ?? `legacy:${userId}`) !== bindingId) throw new HttpError(409, "供应商设置已改变，请刷新后重新提交。");
}

export const store = {
  async getProviderSettingsRow(userId: string): Promise<ProviderSettingsRow | undefined> {
    if (useMemoryStore()) return memory.providerSettings.get(userId);
    return withTenant(userId, async client => {
      const result = await client.query("SELECT * FROM studio_provider_settings WHERE user_id=$1", [userId]);
      return result.rowCount ? providerFromRow(result.rows[0]) : undefined;
    });
  },
  async providerIsBusy(userId: string) {
    if (useMemoryStore()) return memoryProviderBusy(userId);
    return withTenant(userId, client => sqlProviderBusy(client, userId));
  },
  async saveProviderSettingsRow(userId: string, input: Omit<ProviderSettingsRow, "updatedAt">, options: { expectedUpdatedAt?: string; expectedRevision?: string; preserveBinding?: boolean; taskProofs?: Record<string, string>; assetProofs?: Record<string, string> } = {}) {
    const check = (current?: ProviderSettingsRow) => {
      if (input.adapterConfig ? providerRowRevision(current) !== options.expectedRevision : options.expectedUpdatedAt && current?.updatedAt !== options.expectedUpdatedAt) throw new HttpError(409, "API 设置已在另一页面更新，请刷新后重试。");
      if (options.preserveBinding && current?.providerBindingId !== input.providerBindingId) throw new HttpError(409, "供应商绑定已改变，请刷新后重试。");
    };
    if (useMemoryStore()) {
      check(memory.providerSettings.get(userId));
      if (!options.preserveBinding && memoryProviderBusy(userId)) throw new HttpError(409, providerBusyMessage);
      for (const [id, taskId] of Object.entries(options.taskProofs ?? {})) {
        const task = memory.generations.get(key(userId, id));
        if (!task || task.providerTaskId || task.status !== "WAITING_PROVIDER" || task.providerBindingId !== input.providerBindingId) throw new HttpError(409, "待确认任务已改变，请刷新后重试。");
        assertConfirmationAge(task.createdAt); assertRemoteId(taskId);
      }
      for (const [id, assetId] of Object.entries(options.assetProofs ?? {})) {
        const asset = memory.assets.get(key(userId, id));
        if (!asset || asset.providerAssetId || asset.providerStatus !== "processing" || asset.providerBindingId !== input.providerBindingId) throw new HttpError(409, "待确认素材已改变，请刷新后重试。");
        assertConfirmationAge(asset.registrationStartedAt ?? asset.createdAt); assertRemoteId(assetId);
      }
      for (const [id, taskId] of Object.entries(options.taskProofs ?? {})) memory.generations.set(key(userId, id), { ...memory.generations.get(key(userId, id))!, providerTaskId: taskId, errorMessage: undefined });
      for (const [id, assetId] of Object.entries(options.assetProofs ?? {})) memory.assets.set(key(userId, id), { ...memory.assets.get(key(userId, id))!, providerAssetId: assetId });
      memory.providerSettings.set(userId, { ...input, updatedAt: new Date().toISOString() }); return;
    }
    await withTenant(userId, async client => {
      await lockProvider(client, userId);
      const result = await client.query("SELECT * FROM studio_provider_settings WHERE user_id=$1", [userId]);
      check(result.rowCount ? providerFromRow(result.rows[0]) : undefined);
      if (!options.preserveBinding && await sqlProviderBusy(client, userId)) throw new HttpError(409, providerBusyMessage);
      for (const [id, taskId] of Object.entries(options.taskProofs ?? {})) {
        assertRemoteId(taskId);
        const result = await client.query("UPDATE studio_generations SET provider_task_id=$3,error_message=NULL,updated_at=NOW() WHERE user_id=$1 AND id=$2 AND provider_task_id IS NULL AND status='WAITING_PROVIDER' AND provider_binding_id=$4 AND created_at < NOW()-INTERVAL '2 minutes' RETURNING id", [userId, id, taskId, input.providerBindingId]);
        if (!result.rowCount) throw new HttpError(409, "待确认任务已改变或提交尚未满 2 分钟，请稍后刷新。");
      }
      for (const [id, assetId] of Object.entries(options.assetProofs ?? {})) {
        assertRemoteId(assetId);
        const result = await client.query("UPDATE studio_assets SET provider_asset_id=$3 WHERE user_id=$1 AND id=$2 AND provider_asset_id IS NULL AND provider_status='processing' AND provider_binding_id=$4 AND COALESCE(registration_started_at,created_at) < NOW()-INTERVAL '2 minutes' RETURNING id", [userId, id, assetId, input.providerBindingId]);
        if (!result.rowCount) throw new HttpError(409, "待确认素材已改变或提交尚未满 2 分钟，请稍后刷新。");
      }
      await client.query("INSERT INTO studio_provider_settings (id,user_id,encrypted_token,base_url,model,adapter_config,encrypted_credentials,provider_binding_id,updated_at) VALUES ($1,$1,$2,$3,$4,$5,$6,$7,NOW()) ON CONFLICT (user_id) DO UPDATE SET encrypted_token=EXCLUDED.encrypted_token,base_url=EXCLUDED.base_url,model=EXCLUDED.model,adapter_config=EXCLUDED.adapter_config,encrypted_credentials=EXCLUDED.encrypted_credentials,provider_binding_id=EXCLUDED.provider_binding_id,updated_at=NOW()", [userId, input.encryptedToken, input.baseUrl, input.model, input.adapterConfig ?? null, input.encryptedCredentials ?? null, input.providerBindingId ?? `legacy:${userId}`]);
    });
  },
  async deleteProviderSettingsRow(userId: string) {
    if (useMemoryStore()) { if (memoryProviderBusy(userId)) throw new HttpError(409, providerBusyMessage); memory.providerSettings.delete(userId); return; }
    await withTenant(userId, async client => {
      await lockProvider(client, userId);
      if (await sqlProviderBusy(client, userId)) throw new HttpError(409, providerBusyMessage);
      await client.query("DELETE FROM studio_provider_settings WHERE user_id=$1", [userId]);
    });
  },
  async getStorageSettingsRow(userId: string) {
    if (useMemoryStore()) return memory.storageSettings.get(userId);
    return withTenant(userId, async (client) => {
      const result = await client.query("SELECT * FROM studio_storage_settings WHERE user_id=$1", [userId]);
      return result.rowCount ? storageFromRow(result.rows[0]) : undefined;
    });
  },
  async saveStorageSettingsRow(row: StorageSettingsRow) {
    if (useMemoryStore()) { memory.storageSettings.set(row.userId, row); return; }
    await withTenant(row.userId, (client) => client.query("INSERT INTO studio_storage_settings (user_id,account_id,bucket,jurisdiction,encrypted_credentials,namespace,state,verified_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW()) ON CONFLICT (user_id) DO UPDATE SET account_id=EXCLUDED.account_id,bucket=EXCLUDED.bucket,jurisdiction=EXCLUDED.jurisdiction,encrypted_credentials=EXCLUDED.encrypted_credentials,namespace=EXCLUDED.namespace,state=EXCLUDED.state,verified_at=EXCLUDED.verified_at,updated_at=NOW()", [row.userId, row.accountId, row.bucket, row.jurisdiction, row.encryptedCredentials, row.namespace, row.state, row.verifiedAt ?? null]));
  },
  async updateStorageState(userId: string, state: StorageState) {
    const current = await this.getStorageSettingsRow(userId); if (!current) return undefined;
    const updated = { ...current, state, updatedAt: new Date().toISOString() }; await this.saveStorageSettingsRow(updated); return updated;
  },
  async disconnectStorage(userId: string) {
    const current = await this.getStorageSettingsRow(userId); if (!current) return undefined;
    const updated = { ...current, encryptedCredentials: null, state: "disconnected" as const, updatedAt: new Date().toISOString() }; await this.saveStorageSettingsRow(updated); return updated;
  },
  async listAssets(userId: string) {
    if (useMemoryStore()) return [...memory.assets.entries()].filter(([id]) => id.startsWith(`${userId}:`)).map(([, asset]) => asset).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return withTenant(userId, async (client) => (await client.query("SELECT * FROM studio_assets WHERE user_id=$1 ORDER BY created_at DESC", [userId])).rows.map(assetFromRow));
  },
  async getAssets(userId: string, ids: string[]) { return new Map((await this.listAssets(userId)).filter((asset) => ids.includes(asset.id)).map((asset) => [asset.id, asset])); },
  async getAsset(userId: string, id: string) {
    if (useMemoryStore()) return memory.assets.get(key(userId, id));
    return withTenant(userId, async (client) => { const result = await client.query("SELECT * FROM studio_assets WHERE id=$1 AND user_id=$2", [id, userId]); return result.rowCount ? assetFromRow(result.rows[0]) : undefined; });
  },
  async createAsset(userId: string, input: Omit<StudioAsset, "id" | "createdAt" | "providerStatus"> & { providerStatus?: StudioAsset["providerStatus"] }) {
    const asset: StudioAsset = { ...input, id: randomUUID(), providerStatus: input.providerStatus ?? "unregistered", createdAt: new Date().toISOString() };
    if (useMemoryStore()) memory.assets.set(key(userId, asset.id), asset);
    else await withTenant(userId, (client) => client.query("INSERT INTO studio_assets (id,user_id,name,type,purpose,source_url,provider_status,provider_binding_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)", [asset.id, userId, asset.name, asset.type, asset.purpose, asset.sourceUrl, asset.providerStatus, asset.providerBindingId ?? null]));
    return asset;
  },
  async updateAssetRegistration(userId: string, id: string, providerAssetId: string | undefined, providerStatus: StudioAsset["providerStatus"], providerBindingId?: string) {
    if (useMemoryStore()) { const current = memory.assets.get(key(userId, id)); if (!current) throw new Error("素材不存在。"); if (providerBindingId && current.providerBindingId !== providerBindingId) throw new HttpError(409, "素材绑定已改变。"); const updated = { ...current, providerAssetId, providerStatus }; memory.assets.set(key(userId, id), updated); return updated; }
    return withTenant(userId, async (client) => { const result = await client.query("UPDATE studio_assets SET provider_asset_id=$3,provider_status=$4 WHERE id=$1 AND user_id=$2 AND ($5::text IS NULL OR provider_binding_id=$5) RETURNING *", [id, userId, providerAssetId ?? null, providerStatus, providerBindingId ?? null]); if (!result.rowCount) throw new Error("素材不存在。"); return assetFromRow(result.rows[0]); });
  },
  async beginAssetRegistration(userId: string, id: string, bindingId: string) {
    if (useMemoryStore()) {
      assertMemoryBinding(userId, bindingId);
      const asset = memory.assets.get(key(userId, id));
      if (!asset || asset.providerStatus === "temporary") throw new HttpError(400, "此素材不能登记。");
      if (asset.providerStatus === "processing" || asset.providerStatus === "ready" && asset.providerBindingId === bindingId) throw new HttpError(409, "素材已登记或正在登记，请刷新状态。");
      const updated = { ...asset, providerBindingId: bindingId, providerAssetId: undefined, providerStatus: "processing" as const, registrationStartedAt: new Date().toISOString() };
      memory.assets.set(key(userId, id), updated); return updated;
    }
    return withTenant(userId, async client => {
      await lockProvider(client, userId); await assertBinding(client, userId, bindingId);
      const result = await client.query("UPDATE studio_assets SET provider_binding_id=$3,provider_asset_id=NULL,provider_status='processing',registration_started_at=NOW() WHERE user_id=$1 AND id=$2 AND provider_status NOT IN ('processing','temporary') AND NOT (provider_status='ready' AND provider_binding_id IS NOT DISTINCT FROM $3) RETURNING *", [userId, id, bindingId]);
      if (!result.rowCount) throw new HttpError(409, "素材已登记或正在登记，请刷新状态。");
      return assetFromRow(result.rows[0]);
    });
  },
  async countGenerationsUsingAsset(userId: string, id: string) {
    if (useMemoryStore()) return [...memory.generations.entries()].filter(([entryId, generation]) => entryId.startsWith(`${userId}:`) && generation.input.references?.some((reference) => reference.assetId === id)).length;
    return withTenant(userId, async (client) => Number((await client.query("SELECT COUNT(*)::int AS count FROM studio_generations WHERE user_id=$1 AND EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(request_json->'references','[]'::jsonb)) AS reference WHERE reference->>'assetId'=$2)", [userId, id])).rows[0]?.count ?? 0));
  },
  async deleteAsset(userId: string, id: string) {
    if (useMemoryStore()) { const current = memory.assets.get(key(userId, id)); if (!current) return undefined; memory.assets.delete(key(userId, id)); return current; }
    return withTenant(userId, async (client) => { const result = await client.query("DELETE FROM studio_assets WHERE id=$1 AND user_id=$2 RETURNING *", [id, userId]); return result.rowCount ? assetFromRow(result.rows[0]) : undefined; });
  },
  async listGenerations(userId: string) {
    if (useMemoryStore()) return [...memory.generations.entries()].filter(([id]) => id.startsWith(`${userId}:`)).map(([, generation]) => generation).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    return withTenant(userId, async (client) => (await client.query("SELECT * FROM studio_generations WHERE user_id=$1 ORDER BY created_at ASC", [userId])).rows.map(generationFromRow));
  },
  async getGeneration(userId: string, id: string) {
    if (useMemoryStore()) return memory.generations.get(key(userId, id));
    return withTenant(userId, async (client) => { const result = await client.query("SELECT * FROM studio_generations WHERE id=$1 AND user_id=$2", [id, userId]); return result.rowCount ? generationFromRow(result.rows[0]) : undefined; });
  },
  async createGeneration(userId: string, record: GenerationRecord) {
    if (useMemoryStore()) memory.generations.set(key(userId, record.id), record);
    else await withTenant(userId, (client) => client.query("INSERT INTO studio_generations (id,user_id,provider_task_id,mode,model,prompt,request_json,status,parent_generation_id,provider_binding_id,provider_snapshot,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NOW(),NOW())", [record.id, userId, record.providerTaskId ?? null, record.mode, record.model, record.prompt, record.input, record.status, record.parentGenerationId ?? null, record.providerBindingId ?? `legacy:${userId}`, record.providerSnapshot ?? null]));
    return record;
  },
  async reserveGeneration(userId: string, record: GenerationRecord): Promise<{ record: GenerationRecord; created: boolean }> {
    const existingResult = (existing: GenerationRecord) => {
      if (!isDeepStrictEqual(existing.input, JSON.parse(JSON.stringify(record.input)))) throw new HttpError(409, "此请求识别码已用于其他生成内容。");
      return { record: existing, created: false };
    };
    if (useMemoryStore()) {
      const existing = memory.generations.get(key(userId, record.id));
      if (existing) return existingResult(existing);
      assertMemoryBinding(userId, record.providerBindingId);
      const count = [...memory.generations.entries()].filter(([id, g]) => id.startsWith(`${userId}:`) && active.includes(g.status)).length;
      if (count >= 2) throw new HttpError(429, "每个账户最多同时进行 2 个生成任务。");
      memory.generations.set(key(userId, record.id), record);
      return { record, created: true };
    }
    return withTenant(userId, async client => {
      // Share the user lock with configuration changes and asset registration.
      await lockProvider(client, userId);
      const lock = await client.query("SELECT user_id FROM studio_storage_settings WHERE user_id=$1 AND state='connected' FOR UPDATE", [userId]);
      if (!lock.rowCount) throw new HttpError(409, "请先重新连接 R2。");
      const existing = await client.query("SELECT * FROM studio_generations WHERE user_id=$1 AND id=$2", [userId, record.id]);
      if (existing.rowCount) return existingResult(generationFromRow(existing.rows[0]));
      await assertBinding(client, userId, record.providerBindingId);
      const count = await client.query("SELECT COUNT(*)::int AS count FROM studio_generations WHERE user_id=$1 AND status=ANY($2)", [userId, active]);
      if (Number(count.rows[0].count) >= 2) throw new HttpError(429, "每个账户最多同时进行 2 个生成任务。");
      const result = await client.query("INSERT INTO studio_generations(id,user_id,mode,model,prompt,request_json,status,parent_generation_id,error_message,provider_binding_id,provider_snapshot) VALUES($1,$2,$3,$4,$5,$6,'WAITING_PROVIDER',$7,$8,$9,$10) RETURNING *", [record.id, userId, record.mode, record.model, record.prompt, record.input, record.parentGenerationId ?? null, record.errorMessage ?? null, record.providerBindingId ?? `legacy:${userId}`, record.providerSnapshot ?? null]);
      return { record: generationFromRow(result.rows[0]), created: true };
    });
  },
  async attachProviderTask(userId: string, id: string, providerTaskId: string) {
    if (!providerTaskId.trim()) throw new Error("供应商任务识别码无效。");
    if (useMemoryStore()) {
      const current = memory.generations.get(key(userId, id));
      if (!current || current.providerTaskId || current.status !== "WAITING_PROVIDER") throw new Error("预留任务状态已改变。");
      const updated = { ...current, providerTaskId, errorMessage: undefined, updatedAt: new Date().toISOString() };
      memory.generations.set(key(userId, id), updated); return updated;
    }
    return withTenant(userId, async client => {
      const result = await client.query("UPDATE studio_generations SET provider_task_id=$3,error_message=NULL,updated_at=NOW() WHERE user_id=$1 AND id=$2 AND provider_task_id IS NULL AND status='WAITING_PROVIDER' RETURNING *", [userId, id, providerTaskId]);
      if (!result.rowCount) throw new Error("预留任务状态已改变。");
      return generationFromRow(result.rows[0]);
    });
  },
  async resolveUnknownGeneration(userId: string, id: string, bindingId: string, taskId?: string) {
    if (taskId !== undefined) assertRemoteId(taskId);
    if (useMemoryStore()) {
      assertMemoryBinding(userId, bindingId);
      const current = memory.generations.get(key(userId, id));
      if (!current || current.status !== "WAITING_PROVIDER" || current.providerTaskId || current.providerBindingId !== bindingId) throw new HttpError(409, "任务已不在待确认状态。");
      assertConfirmationAge(current.createdAt);
      const updated = { ...current, providerTaskId: taskId, status: taskId ? "WAITING_PROVIDER" as const : "FAILURE" as const, errorMessage: taskId ? undefined : "用户已在供应商控制台确认未创建任务。", updatedAt: new Date().toISOString() };
      memory.generations.set(key(userId, id), updated); return updated;
    }
    return withTenant(userId, async client => {
      await lockProvider(client, userId); await assertBinding(client, userId, bindingId);
      const result = await client.query("UPDATE studio_generations SET provider_task_id=$4,status=$5,error_message=$6,updated_at=NOW() WHERE user_id=$1 AND id=$2 AND provider_binding_id=$3 AND status='WAITING_PROVIDER' AND provider_task_id IS NULL AND created_at < NOW()-INTERVAL '2 minutes' RETURNING *", [userId, id, bindingId, taskId ?? null, taskId ? "WAITING_PROVIDER" : "FAILURE", taskId ? null : "用户已在供应商控制台确认未创建任务。"]);
      if (!result.rowCount) throw new HttpError(409, "任务已改变或提交尚未满 2 分钟，请稍后刷新。");
      return generationFromRow(result.rows[0]);
    });
  },
  async resolveUnknownAsset(userId: string, id: string, bindingId: string, assetId?: string) {
    if (assetId !== undefined) assertRemoteId(assetId);
    if (useMemoryStore()) {
      assertMemoryBinding(userId, bindingId);
      const current = memory.assets.get(key(userId, id));
      if (!current || current.providerStatus !== "processing" || current.providerAssetId || current.providerBindingId !== bindingId) throw new HttpError(409, "素材已不在待确认状态。");
      assertConfirmationAge(current.registrationStartedAt ?? current.createdAt);
      const updated = { ...current, providerAssetId: assetId, providerStatus: assetId ? "processing" as const : "failed" as const };
      memory.assets.set(key(userId, id), updated); return updated;
    }
    return withTenant(userId, async client => {
      await lockProvider(client, userId); await assertBinding(client, userId, bindingId);
      const result = await client.query("UPDATE studio_assets SET provider_asset_id=$4,provider_status=$5 WHERE user_id=$1 AND id=$2 AND provider_binding_id=$3 AND provider_status='processing' AND provider_asset_id IS NULL AND COALESCE(registration_started_at,created_at) < NOW()-INTERVAL '2 minutes' RETURNING *", [userId, id, bindingId, assetId ?? null, assetId ? "processing" : "failed"]);
      if (!result.rowCount) throw new HttpError(409, "素材已改变或提交尚未满 2 分钟，请稍后刷新。");
      return assetFromRow(result.rows[0]);
    });
  },
  async updateGeneration(userId: string, id: string, patch: Partial<GenerationRecord>) {
    const existing = await this.getGeneration(userId, id); if (!existing) throw new Error("任务不存在。");
    const updated = { ...existing, ...patch, updatedAt: new Date().toISOString() };
    if (useMemoryStore()) { memory.generations.set(key(userId, id), updated); memory.archiveLeases.delete(key(userId, id)); }
    else await withTenant(userId, (client) => client.query("UPDATE studio_generations SET status=$3,provider_video_url=NULL,saved_video_url=$4,error_message=$5,usage_json=$6,archive_lease_until=NULL,updated_at=NOW() WHERE id=$1 AND user_id=$2", [id, userId, updated.status, updated.savedVideoUrl ?? null, updated.errorMessage ?? null, updated.usage ?? null]));
    return updated;
  },
  async markGenerationStorageError(userId: string, id: string, from: "WAITING_PROVIDER" | "ARCHIVING", errorMessage: string) {
    if (useMemoryStore()) {
      const current = memory.generations.get(key(userId, id));
      if (!current || current.status !== from) return undefined;
      const updated = { ...current, status: "STORAGE_ERROR" as const, errorMessage, updatedAt: new Date().toISOString() };
      memory.generations.set(key(userId, id), updated); memory.archiveLeases.delete(key(userId, id));
      return updated;
    }
    return withTenant(userId, async (client) => {
      const result = await client.query("UPDATE studio_generations SET status='STORAGE_ERROR',error_message=$4,archive_lease_until=NULL,updated_at=NOW() WHERE id=$1 AND user_id=$2 AND status=$3 RETURNING *", [id, userId, from, errorMessage]);
      return result.rowCount ? generationFromRow(result.rows[0]) : undefined;
    });
  },
  async claimGenerationArchiving(userId: string, id: string, from: "WAITING_PROVIDER" | "STORAGE_ERROR") {
    if (useMemoryStore()) { const generation = memory.generations.get(key(userId, id)); if (!generation || generation.status !== from) return undefined; const updated = { ...generation, status: "ARCHIVING" as const, errorMessage: undefined, updatedAt: new Date().toISOString() }; memory.generations.set(key(userId, id), updated); memory.archiveLeases.delete(key(userId, id)); return updated; }
    return withTenant(userId, async (client) => { const result = await client.query("UPDATE studio_generations SET status='ARCHIVING',error_message=NULL,archive_lease_until=NULL,updated_at=NOW() WHERE id=$1 AND user_id=$2 AND status=$3 RETURNING *", [id, userId, from]); return result.rowCount ? generationFromRow(result.rows[0]) : undefined; });
  },
  async claimGenerationArchiveWorker(userId: string, id: string) {
    if (useMemoryStore()) {
      const itemKey = key(userId, id); const generation = memory.generations.get(itemKey);
      if (!generation || generation.status !== "ARCHIVING" || (memory.archiveLeases.get(itemKey) ?? 0) > Date.now()) return undefined;
      memory.archiveLeases.set(itemKey, Date.now() + 30 * 60_000); return generation;
    }
    return withTenant(userId, async client => {
      const result = await client.query("UPDATE studio_generations SET archive_lease_until=NOW()+INTERVAL '30 minutes' WHERE id=$1 AND user_id=$2 AND status='ARCHIVING' AND (archive_lease_until IS NULL OR archive_lease_until<=NOW()) RETURNING *", [id, userId]);
      return result.rowCount ? generationFromRow(result.rows[0]) : undefined;
    });
  },
  async countChildGenerations(userId: string, id: string) {
    if (useMemoryStore()) return [...memory.generations.entries()].filter(([entryId, generation]) => entryId.startsWith(`${userId}:`) && generation.parentGenerationId === id).length;
    return withTenant(userId, async (client) => Number((await client.query("SELECT COUNT(*)::int AS count FROM studio_generations WHERE user_id=$1 AND parent_generation_id=$2", [userId, id])).rows[0]?.count ?? 0));
  },
  async countActiveGenerations(userId: string) {
    if (useMemoryStore()) return [...memory.generations.entries()].filter(([entryId, generation]) => entryId.startsWith(`${userId}:`) && active.includes(generation.status)).length;
    return withTenant(userId, async (client) => Number((await client.query("SELECT COUNT(*)::int AS count FROM studio_generations WHERE user_id=$1 AND status = ANY($2)", [userId, active])).rows[0]?.count ?? 0));
  },
  async listPendingGenerationRefs(limit = 20) {
    if (isLocalMode()) {
      const staleArchive = Date.now() - 20 * 60_000;
      const pending = (await this.listGenerations(LOCAL_USER_ID)).filter(item => item.providerTaskId && (item.status === "WAITING_PROVIDER" || item.status === "ARCHIVING" && Date.parse(item.updatedAt) < staleArchive)).sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
      return { refs: pending.slice(0, Math.min(20, Math.max(1, limit))).map(item => ({ userId: LOCAL_USER_ID, generationId: item.id })), scannedUsers: 1, scanComplete: true };
    }
    const connection = db();
    const maxRefs = Math.min(20, Math.max(1, Math.trunc(limit) || 20));
    const deadline = Date.now() + 25_000;
    const refs: { userId: string; generationId: string; updatedAt: string }[] = [];
    if (!connection) throw new Error("排程验收需要真实的 runtime 数据库连接。");
    let cursor: string | undefined;
    let scannedUsers = 0;
    let scanComplete = false;
    // ponytail: O(users) scan is capped at 25s; add a persistent scan cursor if accounts outgrow this daily sweep.
    try {
      while (Date.now() < deadline) {
        const query: QueryConfig<string[]> & { query_timeout: number } = {
          text: `SELECT id FROM public."user" WHERE "emailVerified"=TRUE${cursor === undefined ? "" : " AND id>$1"} ORDER BY id LIMIT 100`,
          values: cursor === undefined ? [] : [cursor], query_timeout: Math.max(1, deadline - Date.now()),
        };
        const users = await connection.query<{ id: string }>(query);
        for (const { id: userId } of users.rows) {
          if (Date.now() >= deadline) break;
          const pending = await withTenant(userId, (client) => client.query<{ id: string; updated_at: Date }>(
            "SELECT id,updated_at FROM public.studio_generations WHERE user_id=$1 AND provider_task_id IS NOT NULL AND (status='WAITING_PROVIDER' OR (status='ARCHIVING' AND updated_at<NOW()-INTERVAL '20 minutes')) ORDER BY updated_at,id LIMIT $2",
            [userId, maxRefs],
          ), deadline - Date.now());
          refs.push(...pending.rows.map((row) => ({ userId, generationId: row.id, updatedAt: new Date(row.updated_at).toISOString() })));
          refs.sort((a, b) => a.updatedAt.localeCompare(b.updatedAt) || a.generationId.localeCompare(b.generationId));
          refs.length = Math.min(refs.length, maxRefs);
          cursor = userId;
          scannedUsers++;
        }
        if (users.rows.length < 100 && (users.rows.length === 0 || cursor === users.rows.at(-1)?.id)) { scanComplete = true; break; }
      }
    } catch (error) {
      if ((error as { code?: string }).code !== "57014" && !(error instanceof Error && error.message === "Query read timeout")) throw error;
    }
    return { refs: refs.map(({ userId, generationId }) => ({ userId, generationId })), scannedUsers, scanComplete };
  },
  async deleteGeneration(userId: string, id: string) {
    if (useMemoryStore()) { const itemKey = key(userId, id); const current = memory.generations.get(itemKey); if (!current) return undefined; memory.generations.delete(itemKey); memory.archiveLeases.delete(itemKey); return current; }
    return withTenant(userId, async (client) => { const result = await client.query("DELETE FROM studio_generations WHERE id=$1 AND user_id=$2 RETURNING *", [id, userId]); return result.rowCount ? generationFromRow(result.rows[0]) : undefined; });
  },
};
