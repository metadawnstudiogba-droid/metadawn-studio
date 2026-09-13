import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { access } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { getLocalDatabase, closeLocalDatabase, localWorkspaceInfo } from "../lib/local-runtime.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
process.chdir(root);
const command = process.argv[2];
const flag = name => { const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1]; };
if (flag("--data-dir")) process.env.STUDIO_DATA_DIR = flag("--data-dir");
const major = Number(process.versions.node.split(".")[0]);

async function build() {
  await new Promise((resolve, reject) => {
    const env = { ...process.env, STUDIO_MODE: "hosted", NEXT_TELEMETRY_DISABLED: "1" };
    if (process.platform === "win32") env.USERPROFILE = root;
    const child = spawn(process.execPath, [join(root, "node_modules", "next", "dist", "bin", "next"), "build"], { cwd: root, stdio: "inherit", env });
    child.once("error", reject); child.once("exit", code => code === 0 ? resolve() : reject(new Error("本地程序构建失败，请修复上方错误后重试 setup:local。")));
  });
}

async function start() {
  try { await access(join(root, ".next", "BUILD_ID")); }
  catch { throw new Error("请先运行 npm run setup:local 完成安装与构建。"); }
  process.env.STUDIO_MODE = "local";
  process.env.NODE_ENV = "production";
  process.env.NEXT_TELEMETRY_DISABLED = "1";
  const workspace = await getLocalDatabase();
  process.env.STUDIO_DATA_DIR = workspace.directory;
  process.env.STUDIO_LOCAL_PORT = String(workspace.port);
  process.env.STUDIO_LOCAL_RUN_TOKEN = randomBytes(32).toString("hex");
  const hostname = "127.0.0.1";
  const origin = `http://${hostname}:${workspace.port}`;
  const { default: next } = await import("next");
  const app = next({ dev: false, hostname, port: workspace.port, dir: root });
  await app.prepare();
  const handler = app.getRequestHandler();
  const server = createServer((request, response) => { void handler(request, response); });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(workspace.port, hostname, resolve); });
  console.log(`本地工作区已启动：${origin}`);
  console.log(`资料目录：${workspace.directory}`);
  console.log("打开网页，在 API 设置填写自己的生成、素材登记和 R2 凭证。关闭程序：Ctrl+C。");
  let syncing = false;
  let closing = false;
  const synchronize = async () => {
    if (syncing || closing) return;
    syncing = true;
    try { await fetch(`${origin}/api/local/reconcile`, { method: "POST", headers: { Authorization: `Bearer ${process.env.STUDIO_LOCAL_RUN_TOKEN}` }, signal: AbortSignal.timeout(13 * 60_000) }); }
    catch { /* The next run only polls existing tasks; it never resubmits generation. */ }
    finally { syncing = false; }
  };
  const timer = setInterval(() => void synchronize(), 15000);
  void synchronize();
  const shutdown = async () => {
    if (closing) return;
    closing = true; clearInterval(timer);
    console.log("正在关闭本地工作区并保存数据…");
    const forceConnections = setTimeout(() => server.closeAllConnections(), 5000); forceConnections.unref();
    await new Promise(resolve => server.close(resolve));
    clearTimeout(forceConnections);
    await app.close(); await closeLocalDatabase(); process.exit(0);
  };
  process.once("SIGINT", () => void shutdown()); process.once("SIGTERM", () => void shutdown());
}

try {
  if (major < 24 || major >= 27) throw new Error("请安装 Node.js 24 LTS，然后重新运行安装指令。");
  if (process.env.NETLIFY || process.env.SITE_ID || process.env.VERCEL) throw new Error("这些指令只适用于本机，云端部署请使用 hosted 模式。");
  if (command === "setup") {
    process.env.STUDIO_MODE = "local";
    const workspace = await getLocalDatabase({ allowCreate: true, port: flag("--port") });
    process.env.STUDIO_DATA_DIR = workspace.directory;
    console.log(`本地资料目录已就绪：${workspace.directory}`);
    await closeLocalDatabase();
    await build();
    console.log("安装完成。运行 npm run start:local 打开免登录的工作区。");
  } else if (command === "start") await start();
  else if (command === "doctor") {
    const info = await localWorkspaceInfo();
    console.log(`Node.js ${process.versions.node}`);
    console.log(`资料目录：${info.directory}`);
    console.log(`工作区配置与加密密钥有效。网址：http://127.0.0.1:${info.port}`);
    try { await access(join(root, ".next", "BUILD_ID")); console.log("程序构建已存在。"); }
    catch { throw new Error("缺少程序构建，请运行 npm run setup:local。"); }
  } else throw new Error("使用 npm run setup:local、npm run start:local 或 npm run doctor:local。");
} catch (error) {
  await closeLocalDatabase().catch(() => {});
  console.error(error?.code === "EADDRINUSE" ? "本地端口已被占用，请先关闭原有工作区，或重新 setup:local -- --port 3031。" : error instanceof Error ? error.message : "本地工作区操作失败。");
  process.exitCode = 1;
}
