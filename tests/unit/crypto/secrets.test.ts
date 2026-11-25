import { afterEach, expect, test } from "vitest";
import { decryptSecret, encryptSecret } from "@/lib/crypto/secrets";

const original = process.env.SECRETS_KEY;
afterEach(() => {
  process.env.SECRETS_KEY = original;
});

test("round trips and does not store plaintext", () => {
  const enc = encryptSecret("hunter2");
  expect(enc).not.toContain("hunter2");
  expect(decryptSecret(enc)).toBe("hunter2");
  expect(encryptSecret("hunter2")).not.toBe(enc);
});

test("throws a clear error when the key is missing or the wrong length", () => {
  delete process.env.SECRETS_KEY;
  expect(() => encryptSecret("x")).toThrow(/SECRETS_KEY/);
  process.env.SECRETS_KEY = Buffer.alloc(16).toString("base64");
  expect(() => encryptSecret("x")).toThrow(/32 bytes/);
});

test("rejects tampered ciphertext", () => {
  const enc = encryptSecret("abc");
  const buf = Buffer.from(enc, "base64");
  buf[buf.length - 1] ^= 1;
  expect(() => decryptSecret(buf.toString("base64"))).toThrow();
});
