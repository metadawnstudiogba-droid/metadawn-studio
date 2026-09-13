import { createHash, createHmac } from "node:crypto";

// Protocol: https://www.volcengine.com/docs/82379/1298459
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const mac = (key: string | Buffer, value: string) => createHmac("sha256", key).update(value).digest();
const encode = (value: string) => encodeURIComponent(value).replace(/[!'()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);

export function volcengineHeaders(input: { url: URL; method: string; body: string; accessKeyId: string; secretAccessKey: string; region: string; service: string; now?: Date }) {
  const date = (input.now ?? new Date()).toISOString().replace(/[:-]|\.\d{3}/g, "");
  const scope = `${date.slice(0, 8)}/${input.region}/${input.service}/request`;
  const payload = hash(input.body);
  const headers = { host: input.url.host, "x-content-sha256": payload, "x-date": date };
  const signed = "host;x-content-sha256;x-date";
  const query = [...input.url.searchParams].map(([key, value]) => [encode(key), encode(value)]).sort(([ak, av], [bk, bv]) => ak < bk ? -1 : ak > bk ? 1 : av < bv ? -1 : av > bv ? 1 : 0).map(pair => pair.join("=")).join("&");
  const path = input.url.pathname.split("/").map(part => encode(decodeURIComponent(part))).join("/");
  const canonical = [input.method, path, query, Object.entries(headers).map(([key, value]) => `${key}:${value}\n`).join(""), signed, payload].join("\n");
  const toSign = ["HMAC-SHA256", date, scope, hash(canonical)].join("\n");
  const key = mac(mac(mac(mac(input.secretAccessKey, date.slice(0, 8)), input.region), input.service), "request");
  return { ...headers, Authorization: `HMAC-SHA256 Credential=${input.accessKeyId}/${scope}, SignedHeaders=${signed}, Signature=${mac(key, toSign).toString("hex")}` };
}
