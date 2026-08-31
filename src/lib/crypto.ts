import crypto from "node:crypto";

/**
 * AI Provider apiKey 的本地加密：AES-256-GCM，主密钥来自 SECRET_MASTER_KEY。
 * 密文格式: iv.tag.payload (各段 base64)。
 */

function masterKey(): Buffer {
  const secret = process.env.SECRET_MASTER_KEY;
  if (!secret) throw new Error("SECRET_MASTER_KEY 未配置，请在 .env 中设置");
  return crypto.createHash("sha256").update(secret).digest();
}

export function encryptSecret(plain: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", masterKey(), iv);
  const payload = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv.toString("base64"), tag.toString("base64"), payload.toString("base64")].join(".");
}

export function decryptSecret(cipherText: string): string {
  const [ivB64, tagB64, payloadB64] = cipherText.split(".");
  if (!ivB64 || !tagB64 || !payloadB64) throw new Error("密文格式不合法");
  const decipher = crypto.createDecipheriv("aes-256-gcm", masterKey(), Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(payloadB64, "base64")), decipher.final()]).toString("utf8");
}

/** 脱敏展示：保留末 4 位 */
export function maskSecret(cipherText: string): string {
  try {
    const plain = decryptSecret(cipherText);
    if (plain.length <= 8) return "••••••••";
    return `••••••••${plain.slice(-4)}`;
  } catch {
    return "••••••••(解密失败)";
  }
}
