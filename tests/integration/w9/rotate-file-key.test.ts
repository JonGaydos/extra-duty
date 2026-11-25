import { mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { beforeAll, describe, expect, test } from "vitest";
import { asc, eq } from "drizzle-orm";
import { useTestDb } from "../../setup/test-db";
import { makeUser } from "../users/helpers";
import { files } from "@/db/schema";
import type { Actor } from "@/domain/actor";
import { storeFile } from "@/domain/files/files";
import { rotateFileKey } from "@/db/rotate-file-key";
import { decryptFile } from "@/lib/crypto/envelope";
import { createLocalStorage } from "@/lib/storage/local";
import type { Storage } from "@/lib/storage";

const pdf = (n: number) => Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.from(`W-9 number ${n} `.repeat(30))]);

describe("FILE_MASTER_KEY rotation", () => {
  const get = useTestDb();
  let dir: string;
  let storage: Storage;
  let owner: Actor;
  const oldKey = Buffer.from(process.env.FILE_MASTER_KEY!, "base64");
  const newKey = randomBytes(32);

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "extra-duty-rotate-"));
    storage = createLocalStorage(dir);
    owner = (await makeUser(get().db, "personnel", "rotate@example.test")).actor;
  });

  test("an interrupted rotation, then a rerun, moves every readable file, reports the unreadable one, and leaves no truncated file", async () => {
    const { db } = get();
    for (let n = 0; n < 4; n++) {
      await db.transaction((tx) => storeFile(owner, tx, { kind: "w9", filename: "w9.pdf", contentType: "application/pdf", body: pdf(n) }, { only: "pdf" }, storage));
    }
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(8)]);
    await db.transaction((tx) => storeFile(owner, tx, { kind: "attachment", filename: "a.png", contentType: "image/png", body: png }, {}, storage));
    const encrypted = await db.select().from(files).where(eq(files.encrypted, true)).orderBy(asc(files.id));
    // The third file (in id order) was damaged before the rotation.
    await storage.put(encrypted[2].storageKey, Buffer.from("not an encrypted file"), "application/octet-stream");

    // First run: the process dies while writing the second file (its put never finishes).
    let killed!: () => void;
    const died = new Promise<void>((r) => (killed = r));
    let puts = 0;
    const dying: Storage = {
      get: (k) => storage.get(k),
      put: async (k, b, c) => {
        if (++puts === 2) {
          killed();
          return new Promise<void>(() => {});
        }
        return storage.put(k, b, c);
      },
    };
    void rotateFileKey(db, dying, oldKey, newKey);
    await died;

    const r = await rotateFileKey(db, storage, oldKey, newKey);
    expect(r.rotated).toBe(2);
    expect(r.alreadyNew).toBe(1);
    expect(r.failed).toEqual([{ fileId: encrypted[2].id, error: expect.stringMatching(/version|malformed|old master key/) }]);
    for (const [i, f] of encrypted.entries()) {
      if (i === 2) continue;
      expect(decryptFile(await storage.get(f.storageKey), newKey).equals(pdf(i))).toBe(true);
    }
    expect((await readdir(join(dir, "w9"))).filter((n) => n.endsWith(".tmp"))).toEqual([]);

    // A third run changes nothing and still reports the damaged file.
    const again = await rotateFileKey(db, storage, oldKey, newKey);
    expect(again).toMatchObject({ rotated: 0, alreadyNew: 3 });
    expect(again.failed).toHaveLength(1);
  });
});
