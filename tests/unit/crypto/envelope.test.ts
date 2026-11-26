import { createCipheriv, randomBytes } from "node:crypto";
import { expect, test } from "vitest";
import { decryptFile, encryptFile, fileKeyId, masterKeyId, rewrapFile } from "@/lib/crypto/envelope";

const master = randomBytes(32);

test("round trips and does not store plaintext", () => {
  const plain = Buffer.from("w9 contents ".repeat(50));
  const blob = encryptFile(plain, master);
  expect(blob.includes(plain.subarray(0, 12))).toBe(false);
  expect(decryptFile(blob, master).equals(plain)).toBe(true);
  expect(encryptFile(plain, master).equals(blob)).toBe(false);
});

test("a flipped byte makes decrypt throw", () => {
  const blob = encryptFile(Buffer.from("secret"), master);
  for (const i of [0, 5, 40, 80, blob.length - 1]) {
    const bad = Buffer.from(blob);
    bad[i] ^= 1;
    expect(() => decryptFile(bad, master)).toThrow();
  }
});

test("the wrong master key throws", () => {
  expect(() => decryptFile(encryptFile(Buffer.from("x"), master), randomBytes(32))).toThrow();
});

/** The contents part (iv, tag, ciphertext) of a blob: everything after the wrapped data key. */
const contents = (blob: Buffer, plainLength: number) => blob.subarray(blob.length - (12 + 16 + plainLength));

/** A version 1 file, as written before key ids (AAD [1] on both seals, no key id). */
function v1(plain: Buffer, master: Buffer): Buffer {
  const seal = (key: Buffer, data: Buffer) => {
    const iv = randomBytes(12);
    const c = createCipheriv("aes-256-gcm", key, iv);
    c.setAAD(Buffer.from([1]));
    const body = Buffer.concat([c.update(data), c.final()]);
    return Buffer.concat([iv, c.getAuthTag(), body]);
  };
  const dataKey = randomBytes(32);
  return Buffer.concat([Buffer.from([1]), seal(master, dataKey), seal(dataKey, plain)]);
}

test("new files carry the id of the master key that wraps them; version 1 files still open", () => {
  const blob = encryptFile(Buffer.from("x"), master);
  expect(fileKeyId(blob)).toEqual(masterKeyId(master));
  expect(masterKeyId(master)).not.toEqual(masterKeyId(randomBytes(32)));
  const old = v1(Buffer.from("old W-9"), master);
  expect(fileKeyId(old)).toBeNull();
  expect(decryptFile(old, master).toString()).toBe("old W-9");
});

test("rewrapping moves a file to a new master key without touching its contents", () => {
  const oldKey = randomBytes(32);
  const newKey = randomBytes(32);
  const plain = Buffer.from("W-9 contents ".repeat(50));
  for (const blob of [encryptFile(plain, oldKey), v1(plain, oldKey)]) {
    const moved = rewrapFile(blob, oldKey, newKey);
    expect(decryptFile(moved, newKey).equals(plain)).toBe(true);
    expect(() => decryptFile(moved, oldKey)).toThrow();
    expect(fileKeyId(moved)).toEqual(masterKeyId(newKey));
    // Only the wrapped data key changes; the encrypted contents are the same bytes.
    expect(contents(moved, plain.length).equals(contents(blob, plain.length))).toBe(true);
    // Already on the new key (by key id): left exactly as it is, so a rotation can be run again.
    expect(rewrapFile(moved, oldKey, newKey)).toBe(moved);
  }
  expect(() => rewrapFile(encryptFile(plain, oldKey), randomBytes(32), newKey)).toThrow(/old master key/);
});

test("an unknown version or a short file is refused before any key is tried", () => {
  const key = randomBytes(32);
  const good = encryptFile(Buffer.from("hello"), key);
  expect(() => decryptFile(Buffer.concat([Buffer.from([9]), good.subarray(1)]), key)).toThrow("Unsupported encrypted file version.");
  expect(() => decryptFile(Buffer.from([2, 1, 2, 3]), key)).toThrow("Encrypted file is malformed.");
  expect(() => decryptFile(Buffer.from([1, 1, 2, 3]), key)).toThrow("Encrypted file is malformed.");
});
