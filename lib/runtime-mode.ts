export const LOCAL_USER_ID = "local-workspace";

export function isLocalMode() {
  const mode = process.env.STUDIO_MODE || "hosted";
  if (mode !== "local" && mode !== "hosted") throw new Error("STUDIO_MODE 必须是 hosted 或 local。");
  if (mode === "local" && (process.env.NETLIFY || process.env.SITE_ID || process.env.VERCEL)) throw new Error("本地免登录模式不能用于云端部署。");
  return mode === "local";
}

/** Browser-origin and Host checks are repeated inside protected route handlers. */
export function assertLocalRequest(requestHeaders: Headers) {
  if (!isLocalMode()) throw new Error("本地访问未启用。");
  const port = process.env.STUDIO_LOCAL_PORT || "3030";
  if (!/^\d{1,5}$/.test(port) || Number(port) < 1024 || Number(port) > 65535) throw new Error("本地端口无效。");
  const host = requestHeaders.get("host")?.toLowerCase();
  const allowedHosts = [`127.0.0.1:${port}`, `localhost:${port}`];
  if (!host || !allowedHosts.includes(host)) throw new Error("本地工作区仅接受本机地址访问。");
  const forwardedHost = requestHeaders.get("x-forwarded-host")?.toLowerCase();
  if (forwardedHost && forwardedHost !== host) throw new Error("本地工作区不接受转发的主机地址。");
  const origin = requestHeaders.get("origin");
  if (origin && origin !== `http://${host}`) throw new Error("本地工作区不接受其他网站的请求。");
  if (requestHeaders.get("sec-fetch-site") === "cross-site") throw new Error("本地工作区不接受其他网站的请求。");
}
