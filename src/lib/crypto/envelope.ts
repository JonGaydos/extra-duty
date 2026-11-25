import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

/**
 * Envelope encryption. A random data key encrypts the file; the master key wraps the data key.
 *
 * Version 2 (written now):  2 | keyId(8) | wrapIv(12) | wrapTag(16) | wrappedKey(32) | iv(12) | tag(16) | ciphertext
 * Version 1 (still read):   1 |           wrapIv(12) | wrapTag(16) | wrappedKey(32) | iv(12) | tag(16) | ciphertext
 *
 * keyId names the master key that wraps the data key (the first 8 bytes of its SHA-256), so a rotation can tell which
 * files are already on the new key without trying to open them. The wrap is authenticated together with the version
 * and key id; the contents always use the data format byte 1, so a rewrap never touches them.
 */
const V1 = 1;
const V2 = 2;
const DATA_AAD = Buffer.from([1]);
const IV = 12;
const TAG = 16;
const KEY = 32;
const KEY_ID = 8;
const BODY = IV + TAG + KEY + IV + TAG;

export function masterKeyFromEnv(): Buffer {
  const raw = process.env.FILE_MASTER_KEY;
  if (!raw) throw new Error("FILE_MASTER_KEY is not set. Set it to a base64 string of 32 random bytes.");
  const k = Buffer.from(raw, "base64");
  if (k.length !== KEY) throw new Error("FILE_MASTER_KEY must be base64 for exactly 32 bytes.");
  return k;
}

function checkMaster(k: Buffer): void {
  if (k.length !== KEY) throw new Error("Master key must be 32 bytes.");
}

/** The id stored in files wrapped by `masterKey`. It does not reveal the key. */
export function masterKeyId(masterKey: Buffer): Buffer {
  checkMaster(masterKey);
  return createHash("sha256").update(masterKey).digest().subarray(0, KEY_ID);
}

function seal(key: Buffer, plain: Buffer, aad: Buffer): { iv: Buffer; tag: Buffer; body: Buffer } {
  const iv = randomBytes(IV);
  const c = createCipheriv("aes-256-gcm", key, iv);
  c.setAAD(aad);
  const body = Buffer.concat([c.update(plain), c.final()]);
  return { iv, tag: c.getAuthTag(), body };
}

function open(key: Buffer, iv: Buffer, tag: Buffer, body: Buffer, aad: Buffer): Buffer {
  const d = createDecipheriv("aes-256-gcm", key, iv);
  d.setAAD(aad);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(body), d.final()]);
}

type Parsed = { keyId: Buffer | null; wrapAad: Buffer; wrapIv: Buffer; wrapTag: Buffer; wrapped: Buffer; data: Buffer };

function parse(blob: Buffer): Parsed {
  const version = blob[0];
  const head = version === V2 ? 1 + KEY_ID : version === V1 ? 1 : -1;
  if (head < 0) throw new Error("Unsupported encrypted file version.");
  if (blob.length < head + BODY) throw new Error("Encrypted file is malformed.");
  let o = head;
  const take = (n: number) => blob.subarray(o, (o += n));
  return {
    keyId: version === V2 ? blob.subarray(1, 1 + KEY_ID) : null,
    wrapAad: blob.subarray(0, head),
    wrapIv: take(IV),
    wrapTag: take(TAG),
    wrapped: take(KEY),
    data: blob.subarray(o),
  };
}

function wrapWith(masterKey: Buffer, dataKey: Buffer, data: Buffer): Buffer {
  const header = Buffer.concat([Buffer.from([V2]), masterKeyId(masterKey)]);
  const wrap = seal(masterKey, dataKey, header);
  return Buffer.concat([header, wrap.iv, wrap.tag, wrap.body, data]);
}

export function encryptFile(plain: Buffer, masterKey: Buffer): Buffer {
  checkMaster(masterKey);
  const dataKey = randomBytes(KEY);
  const d = seal(dataKey, plain, DATA_AAD);
  return wrapWith(masterKey, dataKey, Buffer.concat([d.iv, d.tag, d.body]));
}

export function decryptFile(blob: Buffer, masterKey: Buffer): Buffer {
  checkMaster(masterKey);
  const p = parse(blob);
  if (p.keyId && !p.keyId.equals(masterKeyId(masterKey))) throw new Error("This file is encrypted with a different FILE_MASTER_KEY.");
  const dataKey = open(masterKey, p.wrapIv, p.wrapTag, p.wrapped, p.wrapAad);
  return open(dataKey, p.data.subarray(0, IV), p.data.subarray(IV, IV + TAG), p.data.subarray(IV + TAG), DATA_AAD);
}

/** The id of the master key a file is wrapped with, or null for a version 1 file (which has none). */
export function fileKeyId(blob: Buffer): Buffer | null {
  return parse(blob).keyId;
}

/**
 * Moves an encrypted file from `oldKey` to `newKey` for a FILE_MASTER_KEY rotation: only the wrapped data key is
 * replaced, so the encrypted contents are untouched. A file whose key id is already the new key's is returned as it
 * is (same Buffer), so an interrupted rotation can simply be run again. Throws when the old key does not open it.
 */
export function rewrapFile(blob: Buffer, oldKey: Buffer, newKey: Buffer): Buffer {
  checkMaster(oldKey);
  checkMaster(newKey);
  const p = parse(blob);
  if (p.keyId?.equals(masterKeyId(newKey))) return blob;
  let dataKey: Buffer;
  try {
    dataKey = open(oldKey, p.wrapIv, p.wrapTag, p.wrapped, p.wrapAad);
  } catch {
    throw new Error("The file does not open with the old master key.");
  }
  return wrapWith(newKey, dataKey, p.data);
}
