import { PGlite } from "@electric-sql/pglite";
import lockfile from "proper-lockfile";
import { createHash, randomBytes } from "node:crypto";
import { homedir, platform } from "node:os";
import { join, resolve, isAbsolute } from "node:path";
import { mkdir, readFile, writeFile, rename, access, readdir } from "node:fs/promises";
import { readFileSync } from "node:fs";

const SCHEMA_VERSION = 1;
const slot = Symbol.for("metadawn.local.database");
const workspaceUser = { id: "local-workspace", name: "本地工作区", email: "local@studio.invalid", emailVerified: true };

export function localDataDirectory() {
  const custom = process.env.STUDIO_DATA_DIR;
  if (custom) { if (!isAbsolute(custom)) throw new Error("STUDIO_DATA_DIR 必须是绝对路径。"); return resolve(custom); }
  if (platform() === "win32") return join(process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local"), "MetadawnStudio");
  if (platform() === "darwin") return join(homedir(), "Library", "Application Support", "MetadawnStudio");
  return join(process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"), "metadawn-studio");
}
async function exists(path) { try { await access(path); return true; } catch { return false; } }
async function atomicJson(path, data) {
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(data, null, 2), { mode: 0o600 });
  await rename(temporary, path);
}

export function localEncryptionKey() {
  try {
    const key = readFileSync(join(localDataDirectory(), "master.key"), "utf8").trim();
    if (!/^[a-f0-9]{64}$/.test(key)) throw new Error();
    return key;
  } catch { throw new Error("本地加密密钥缺失或无效。请恢复工作区备份；已有数据时不能重新生成密钥。"); }
}

/** One connection and one filesystem lock per local workspace process. */
export async function getLocalDatabase({ allowCreate = false, port } = {}) {
  const directory = localDataDirectory();
  const existing = globalThis[slot];
  if (existing) {
    if (existing.directory !== directory) throw new Error("请先关闭当前本地工作区，再切换数据目录。");
    return existing.promise;
  }
  const state = { directory, promise: undefined, release: undefined, database: undefined };
  globalThis[slot] = state;
  state.promise = (async () => {
    const settingsPath = join(directory, "workspace.json");
    if (!allowCreate && !await exists(settingsPath)) throw new Error("请先运行 npm run setup:local 初始化本地工作区。");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    try { state.release = await lockfile.lock(directory, { realpath: true, stale: 30000, update: 10000, retries: 0 }); }
    catch { throw new Error("这个本地工作区已被其他进程打开。请关闭原进程后重试，勿删除锁文件。"); }
    const databasePath = join(directory, "postgres");
    const hasDatabase = await exists(databasePath) && (await readdir(databasePath)).length > 0;
    const hasSettings = await exists(settingsPath);
    if (hasSettings && !hasDatabase) throw new Error("本地数据库缺失，请恢复完整工作区备份，避免创建空白数据库。");
    if (!await exists(join(directory, "master.key"))) {
      if (hasDatabase || hasSettings || !allowCreate) throw new Error("本地加密密钥缺失，请恢复 master.key 备份；现有数据不会被覆盖。");
      await writeFile(join(directory, "master.key"), randomBytes(32).toString("hex"), { flag: "wx", mode: 0o600 });
    }
    localEncryptionKey();
    const settings = hasSettings ? JSON.parse(await readFile(settingsPath, "utf8")) : { version: SCHEMA_VERSION, port: 3030 };
    if (settings.version > SCHEMA_VERSION) throw new Error("本地工作区来自更新版本，请升级程序后再打开。");
    const chosenPort = Number(port ?? settings.port);
    if (!Number.isInteger(chosenPort) || chosenPort < 1024 || chosenPort > 65535) throw new Error("本地端口必须为 1024–65535。");
    const database = await PGlite.create(databasePath);
    state.database = database;
    const roles = await database.query("SELECT rolname FROM pg_roles WHERE rolname='seedance_runtime'");
    if (!roles.rows.length) await database.exec("CREATE ROLE seedance_runtime LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION NOINHERIT");
    const schema = await readFile(join(process.cwd(), "db", "schema.sql"), "utf8");
    const schemaHash = createHash("sha256").update(schema).digest("hex");
    if (settings.schemaHash !== schemaHash) await database.exec(schema);
    await database.query('INSERT INTO public."user" (id,name,email,"emailVerified") VALUES ($1,$2,$3,TRUE) ON CONFLICT(id) DO NOTHING', [workspaceUser.id, workspaceUser.name, workspaceUser.email]);
    await atomicJson(settingsPath, { version: SCHEMA_VERSION, port: chosenPort, schemaHash });
    return { database, user: workspaceUser, directory, port: chosenPort };
  })().catch(async error => {
    await state.database?.close().catch(() => {});
    await state.release?.().catch(() => {});
    if (globalThis[slot] === state) delete globalThis[slot];
    throw error;
  });
  return state.promise;
}

export async function closeLocalDatabase() {
  const state = globalThis[slot];
  if (!state) return;
  try { const result = await state.promise; await result.database.close(); }
  finally { await state.release?.(); if (globalThis[slot] === state) delete globalThis[slot]; }
}

export async function localWorkspaceInfo() {
  const directory = localDataDirectory();
  const settings = JSON.parse(await readFile(join(directory, "workspace.json"), "utf8"));
  localEncryptionKey();
  return { directory, port: settings.port, schemaVersion: settings.version };
}
