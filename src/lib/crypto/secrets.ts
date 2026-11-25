import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const IV_BYTES = 12;
const TAG_BYTES = 16;

function key(): Buffer {
  const raw = process.env.SECRETS_KEY;
  if (!raw) throw new Error("SECRETS_KEY is not set. Set it to a base64 string of 32 random bytes.");
  const k = Buffer.from(raw, "base64");
  if (k.length !== 32) throw new Error("SECRETS_KEY must be base64 for exactly 32 bytes.");
  return k;
}

/** AES-256-GCM. Output is base64 of iv (12) + auth tag (16) + ciphertext. */
export function encryptSecret(plain: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const body = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64");
}

export function decryptSecret(enc: string): string {
  const buf = Buffer.from(enc, "base64");
  if (buf.length < IV_BYTES + TAG_BYTES) throw new Error("Encrypted secret is malformed.");
  const decipher = createDecipheriv("aes-256-gcm", key(), buf.subarray(0, IV_BYTES));
  decipher.setAuthTag(buf.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
  return Buffer.concat([decipher.update(buf.subarray(IV_BYTES + TAG_BYTES)), decipher.final()]).toString("utf8");
}
