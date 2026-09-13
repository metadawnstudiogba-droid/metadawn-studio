import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { isLocalMode } from "./runtime-mode";
import { localEncryptionKey } from "./local-runtime.mjs";

function key() {
  const secret = isLocalMode() ? localEncryptionKey() : process.env.SETTINGS_ENCRYPTION_KEY;
  if (!secret) throw new Error("缺少 SETTINGS_ENCRYPTION_KEY，无法读取已保存的密钥。");
  return createHash("sha256").update(secret).digest();
}

export function encryptSecret(value: string, aad: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  cipher.setAAD(Buffer.from(aad));
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return `v2:${iv.toString("base64")}:${cipher.getAuthTag().toString("base64")}:${encrypted.toString("base64")}`;
}

export function decryptSecret(payload: string, aad: string) {
  const [version, iv, tag, encrypted] = payload.split(":");
  if (version !== "v2" || !iv || !tag || !encrypted) throw new Error("已保存的密钥格式无效。");
  const decipher = createDecipheriv("aes-256-gcm", key(), Buffer.from(iv, "base64"));
  decipher.setAAD(Buffer.from(aad));
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(encrypted, "base64")), decipher.final()]).toString("utf8");
}
