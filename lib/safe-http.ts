import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { Agent, fetch as undiciFetch } from "undici";
import ipaddr from "ipaddr.js";

export function isPublicAddress(address: string) {
  try {
    let parsed = ipaddr.parse(address);
    if (parsed.kind() === "ipv6" && (parsed as ipaddr.IPv6).isIPv4MappedAddress()) parsed = (parsed as ipaddr.IPv6).toIPv4Address();
    return parsed.range() === "unicast";
  } catch { return false; }
}

function isSyntheticProxyAddress(address: string) {
  try {
    const parsed = ipaddr.parse(address);
    if (parsed.kind() !== "ipv4") return false;
    const [first, second] = (parsed as ipaddr.IPv4).toByteArray();
    return first === 198 && (second === 18 || second === 19);
  } catch { return false; }
}

async function resolveWithPublicDns(hostname: string) {
  const addresses: Array<{ address: string; family: number }> = [];
  for (const type of ["A", "AAAA"] as const) {
    const endpoint = new URL("https://1.1.1.1/dns-query");
    endpoint.searchParams.set("name", hostname);
    endpoint.searchParams.set("type", type);
    const response = await safeFetch(endpoint, { headers: { Accept: "application/dns-json" }, signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error("公共 DNS 查询失败。");
    const payload = await readJsonResponse(response) as { Status?: unknown; Answer?: Array<{ type?: unknown; data?: unknown }> };
    if (payload.Status !== 0 && payload.Status !== 3) throw new Error("公共 DNS 查询失败。");
    for (const answer of payload.Answer ?? []) {
      const family = answer.type === 1 ? 4 : answer.type === 28 ? 6 : 0;
      if (family && typeof answer.data === "string" && isIP(answer.data) === family) addresses.push({ address: answer.data, family });
    }
  }
  if (!addresses.length || addresses.some(item => !isPublicAddress(item.address))) throw new Error("接口必须解析到公共网络地址。");
  return [...new Map(addresses.map(item => [`${item.family}:${item.address}`, item])).values()];
}

export async function publicAddresses(hostname: string) {
  const host = hostname.replace(/^\[|\]$/g, "");
  if (host.toLowerCase() === "localhost" || host.toLowerCase().endsWith(".localhost") || host.endsWith(".")) throw new Error("接口不能连接本机或私有网络。");
  const addresses = isIP(host) ? [{ address: host, family: isIP(host) }] : await lookup(host, { all: true, verbatim: true });
  if (addresses.length && addresses.every(item => isSyntheticProxyAddress(item.address))) return resolveWithPublicDns(host);
  if (!addresses.length || addresses.some(item => !isPublicAddress(item.address))) throw new Error("接口必须解析到公共网络地址。");
  return addresses;
}

function parsePublicUrl(value: string) {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.hash || url.port && url.port !== "443") throw new Error("仅允许 HTTPS 公共地址，端口为 443。");
  return url;
}

export async function assertPublicUrl(value: string) {
  const url = parsePublicUrl(value);
  await publicAddresses(url.hostname);
  return url;
}

/** Resolve once and pin the connection to the checked IPs, including during TLS. */
export async function safeFetch(value: string | URL, init: { method?: string; headers?: HeadersInit; body?: string; signal?: AbortSignal } = {}): Promise<Response> {
  const url = parsePublicUrl(String(value));
  const addresses = await publicAddresses(url.hostname);
  const dispatcher = new Agent({ connect: {
    lookup: (_hostname, options, callback) => {
      const family = typeof options === "object" ? options.family : options;
      const candidates = family === 4 || family === 6 ? addresses.filter(item => item.family === family) : addresses;
      if (!candidates.length) { callback(new Error("接口没有可用的公共地址。"), "", 0); return; }
      if (typeof options === "object" && options.all) callback(null, candidates);
      else callback(null, candidates[0].address, candidates[0].family);
    },
  } });
  try {
    const response = await undiciFetch(url, { ...init, headers: Object.fromEntries(new Headers(init.headers)), redirect: "manual", dispatcher, signal: init.signal ?? AbortSignal.timeout(60_000) });
    if (response.status >= 300 && response.status < 400) { await response.body?.cancel(); throw new Error("接口重定向被拒绝，请填写最终 API 地址。"); }
    const reader = response.body?.getReader();
    if (!reader) { await dispatcher.close(); return new Response(null, { status: response.status, headers: Object.fromEntries(response.headers) }); }
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try { const chunk = await reader.read(); if (chunk.done) { controller.close(); await dispatcher.close(); } else controller.enqueue(chunk.value); }
        catch (error) { controller.error(error); await dispatcher.destroy().catch(() => {}); }
      },
      async cancel(reason) { await reader.cancel(reason).catch(() => {}); await dispatcher.destroy().catch(() => {}); },
    });
    return new Response(body, { status: response.status, headers: Object.fromEntries(response.headers) });
  } catch (error) { await dispatcher.destroy().catch(() => {}); throw error; }
}

export async function readJsonResponse(response: Response) {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("接口返回空响应。");
  const chunks: Uint8Array[] = []; let bytes = 0;
  try {
    while (true) {
      const part = await reader.read(); if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > 2 * 1024 * 1024) throw new Error("接口响应超过 2 MB。");
      chunks.push(part.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch { await reader.cancel().catch(() => {}); throw new Error("接口未返回有效且符合大小限制的 JSON。"); }
}
