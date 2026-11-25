/**
 * FILE_MASTER_KEY rotation (ROLE=rotate-file-key). Stop web and the worker first, then run it with the old key in
 * FILE_MASTER_KEY_OLD and the new one in FILE_MASTER_KEY. Every app-encrypted file (W-9s), live and training, gets
 * its data key wrapped again with the new key; contents are not re-encrypted. Safe to run again after an
 * interruption: files already on the new key (by key id) are skipped. Files that cannot be read are listed, the rest
 * still move, and the run exits non-zero. Steps: docs/operations.md, "Rotating FILE_MASTER_KEY".
 */
import { asc, eq } from "drizzle-orm";
import { fileURLToPath } from "node:url";
import { dbFor, runInMode, trainingConfigured, type Db, type DataMode } from "./client";
import { files } from "./schema";
import { rewrapFile } from "../lib/crypto/envelope";
import { storageFor, type Storage } from "../lib/storage";

export type RotationResult = { rotated: number; alreadyNew: number; failed: Array<{ fileId: string; error: string }> };

/**
 * Moves every encrypted file to `newKey`, in id order. Files whose key id is already the new key's are skipped, so
 * a rerun after an interruption picks up where it stopped. A file that cannot be read or moved is listed in
 * `failed` and the rest still go on.
 */
export async function rotateFileKey(db: Db, storage: Storage, oldKey: Buffer, newKey: Buffer): Promise<RotationResult> {
  const rows = await db.select({ id: files.id, storageKey: files.storageKey }).from(files).where(eq(files.encrypted, true)).orderBy(asc(files.id));
  const result: RotationResult = { rotated: 0, alreadyNew: 0, failed: [] };
  for (const row of rows) {
    try {
      const blob = await storage.get(row.storageKey);
      const moved = rewrapFile(blob, oldKey, newKey);
      if (moved === blob) {
        result.alreadyNew++;
        continue;
      }
      await storage.put(row.storageKey, moved, "application/octet-stream");
      result.rotated++;
    } catch (err) {
      result.failed.push({ fileId: row.id, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return result;
}

function key(name: string): Buffer {
  const raw = process.env[name];
  const k = raw ? Buffer.from(raw, "base64") : Buffer.alloc(0);
  if (k.length !== 32) throw new Error(`${name} must be set to base64 for exactly 32 bytes.`);
  return k;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const run = async () => {
    const oldKey = key("FILE_MASTER_KEY_OLD");
    const newKey = key("FILE_MASTER_KEY");
    if (oldKey.equals(newKey)) throw new Error("FILE_MASTER_KEY_OLD and FILE_MASTER_KEY are the same key.");
    const modes: DataMode[] = trainingConfigured() ? ["live", "training"] : ["live"];
    let failed = 0;
    for (const mode of modes) {
      const r = await runInMode(mode, () => rotateFileKey(dbFor(mode), storageFor(mode), oldKey, newKey));
      console.log(`rotate-file-key: ${mode}: ${r.rotated} moved to the new key, ${r.alreadyNew} already on it, ${r.failed.length} failed`);
      for (const f of r.failed) console.log(`  file ${f.fileId}: ${f.error}`);
      failed += r.failed.length;
      await dbFor(mode).$client.end();
    }
    if (failed) throw new Error(`${failed} file(s) could not be moved; they are listed above. Fix or restore them, then run this again.`);
  };
  run().then(
    () => process.exit(0),
    (err) => {
      console.error("rotate-file-key failed:", err instanceof Error ? err.message : err);
      process.exit(1);
    },
  );
}
