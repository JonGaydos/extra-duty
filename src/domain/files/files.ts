import { eq } from "drizzle-orm";
import type { Tx } from "@/db/client";
import { files } from "@/db/schema";
import type { Actor } from "@/domain/actor";
import { recordAudit } from "@/domain/audit/audit";
import { NotFoundError, ValidationError } from "@/domain/errors";
import { encryptFile, masterKeyFromEnv } from "@/lib/crypto/envelope";
import { getStorage, type Storage } from "@/lib/storage";
import { uuidv7 } from "uuidv7";

export type FileRow = typeof files.$inferSelect;
export type FileKind = FileRow["kind"];

export const MAX_FILE_BYTES = 20 * 1024 * 1024;
export const MAX_FILENAME = 255;
export const W9_FILENAME = "W-9.pdf";

type Detected = "pdf" | "docx" | "doc" | "jpg" | "png";

const TYPES: Record<string, Detected> = {
  "application/pdf": "pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/msword": "doc",
  "image/jpeg": "jpg",
  "image/png": "png",
};

const MAGIC: Record<Detected, number[]> = {
  pdf: [0x25, 0x50, 0x44, 0x46, 0x2d],
  docx: [0x50, 0x4b, 0x03, 0x04],
  doc: [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1],
  jpg: [0xff, 0xd8, 0xff],
  png: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
};

function matchesMagic(body: Buffer, kind: Detected): boolean {
  const m = MAGIC[kind];
  return body.length >= m.length && m.every((b, i) => body[i] === b);
}

/** Validates size, declared content type and magic bytes. Returns the normalized content type. */
export function validateUpload(body: Buffer, contentType: string, only?: Detected | readonly Detected[]): string {
  const ct = contentType.split(";")[0].trim().toLowerCase();
  const kind = TYPES[ct];
  // Legacy .doc is accepted only where a caller names it in `only`.
  const allowed = only === undefined ? undefined : typeof only === "string" ? [only] : only;
  if (!kind || (allowed ? !allowed.includes(kind) : kind === "doc")) {
    throw new ValidationError(
      !allowed
        ? "Only PDF, DOCX, JPG and PNG files are allowed."
        : allowed.length === 1 && allowed[0] === "pdf"
          ? "Only PDF files are allowed."
          : `Only ${allowed.map((k) => k.toUpperCase()).join(", ")} files are allowed.`,
    );
  }
  if (body.length === 0) throw new ValidationError("The file is empty.");
  if (body.length > MAX_FILE_BYTES) throw new ValidationError("Files can be at most 20 MB.");
  if (!matchesMagic(body, kind)) throw new ValidationError("The file contents do not match its type.");
  return ct;
}

export type UploadInput = {
  kind: FileKind;
  filename: string;
  contentType: string;
  body: Buffer;
  ownerUserId?: string;
};

/**
 * Stores a file and its row. Callers authorize the action (it differs per kind)
 * and, for W-9s, use uploadW9. The object is written before the transaction
 * commits, so a rollback can leave an unreferenced object in storage.
 */
export async function storeFile(
  actor: Actor | "system",
  tx: Tx,
  input: UploadInput,
  opts: { only?: Detected | readonly Detected[] } = {},
  storage: Storage = getStorage(),
): Promise<FileRow> {
  const isW9 = input.kind === "w9";
  // Only W-9s are encrypted by the app (they always are).
  const encrypt = isW9;
  const contentType = validateUpload(input.body, input.contentType, opts.only);
  // W-9 filenames can carry names or SSNs: never keep the supplied one.
  const filename = isW9
    ? W9_FILENAME
    : (input.filename.replace(/[\\/\u0000-\u001f]/g, "_").trim().slice(0, MAX_FILENAME) || "file");
  const storageKey = `${input.kind}/${uuidv7()}`;
  const stored = encrypt ? encryptFile(input.body, masterKeyFromEnv()) : input.body;
  await storage.put(storageKey, stored, encrypt ? "application/octet-stream" : contentType);
  const [row] = await tx
    .insert(files)
    .values({
      storageKey,
      filename,
      contentType,
      size: input.body.length,
      encrypted: encrypt,
      ownerUserId: input.ownerUserId ?? null,
      kind: input.kind,
    })
    .returning();
  await recordAudit(tx, {
    actor,
    action: "file.upload",
    entityType: "file",
    entityId: row.id,
    after: isW9
      ? { kind: row.kind, size: row.size, encrypted: row.encrypted }
      : { kind: row.kind, filename: row.filename, contentType, size: row.size, encrypted: row.encrypted },
  });
  return row;
}

export async function uploadFile(actor: Actor, tx: Tx, input: UploadInput, storage?: Storage): Promise<FileRow> {
  if (input.kind === "w9") throw new ValidationError("W-9 files must be uploaded as a W-9.");
  return storeFile(actor, tx, input, {}, storage);
}

/** Generic reader for non-W-9 files. W-9s are read only through readW9 (authorized and audited). No policy check here. */
export async function readStoredFile(tx: Tx, fileId: string, storage: Storage = getStorage()): Promise<{ row: FileRow; body: Buffer }> {
  const [row] = await tx.select().from(files).where(eq(files.id, fileId));
  if (!row || row.kind === "w9" || row.encrypted) throw new NotFoundError("File not found.");
  return { row, body: await storage.get(row.storageKey) };
}
