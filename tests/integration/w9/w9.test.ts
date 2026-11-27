import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, test } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { useTestDb } from "../../setup/test-db";
import { makeUser } from "../users/helpers";
import { auditLog, files, w9s } from "@/db/schema";
import type { Actor } from "@/domain/actor";
import { ForbiddenError, NotFoundError, ValidationError } from "@/domain/errors";
import { readStoredFile, storeFile, uploadFile } from "@/domain/files/files";
import { currentW9, readW9, uploadW9 } from "@/domain/w9/w9";
import { createLocalStorage } from "@/lib/storage/local";
import type { Storage } from "@/lib/storage";

const PDF = Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.from("SSN 123-45-6789 ".repeat(20))]);
const PDF2 = Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.from("second w9 ".repeat(20))]);

describe("files and W-9", () => {
  const get = useTestDb();
  let storage: Storage;
  let owner: Actor;
  let other: Actor;
  let coordinator: Actor;
  let vendor: Actor;
  const puts: Buffer[] = [];

  beforeAll(async () => {
    const { db } = get();
    const local = createLocalStorage(await mkdtemp(join(tmpdir(), "extra-duty-files-")));
    storage = {
      put: async (k, b, c) => {
        puts.push(b);
        await local.put(k, b, c);
      },
      get: (k) => local.get(k),
    };
    owner = (await makeUser(db, "personnel", "owner@example.test", {}, { w9: false })).actor;
    other = (await makeUser(db, "personnel", "other@example.test", {}, { w9: false })).actor;
    coordinator = (await makeUser(db, "coordinator", "coord@example.test", {}, { w9: false })).actor;
    vendor = (await makeUser(db, "vendor", "vend@example.test")).actor;
  });

  test("the stored object is encrypted, not the uploaded bytes", async () => {
    const { db } = get();
    await db.transaction((tx) => uploadW9(owner, tx, PDF, "w9.pdf", storage));
    expect(puts).toHaveLength(1);
    expect(puts[0].equals(PDF)).toBe(false);
    expect(puts[0].includes(Buffer.from("123-45-6789"))).toBe(false);
  });

  test("the owner and a coordinator can read; the read is audited without content", async () => {
    const { db } = get();
    const own = await db.transaction((tx) => readW9(owner, tx, owner.userId, storage));
    expect(own.body.equals(PDF)).toBe(true);
    const res = await db.transaction((tx) => readW9(coordinator, tx, owner.userId, storage));
    expect(res.body.equals(PDF)).toBe(true);
    expect(res.filename).toBe("W-9.pdf");
    const rows = await db.select().from(auditLog).where(and(eq(auditLog.action, "w9.read"), eq(auditLog.actorUserId, coordinator.userId)));
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows[0])).not.toContain("123-45-6789");
  });

  test("another personnel user and a vendor are forbidden", async () => {
    const { db } = get();
    await expect(db.transaction((tx) => readW9(other, tx, owner.userId, storage))).rejects.toBeInstanceOf(ForbiddenError);
    await expect(db.transaction((tx) => readW9(vendor, tx, owner.userId, storage))).rejects.toBeInstanceOf(ForbiddenError);
  });

  test("a new W-9 becomes current and the old one is kept as history", async () => {
    const { db } = get();
    const first = await db.transaction((tx) => currentW9(tx, owner.userId));
    const second = await db.transaction((tx) => uploadW9(owner, tx, PDF2, "w9-new.pdf", storage));
    const all = await db.select().from(w9s).where(eq(w9s.userId, owner.userId));
    expect(all).toHaveLength(2);
    expect(all.find((r) => r.id === first!.id)!.current).toBe(false);
    expect((await db.transaction((tx) => currentW9(tx, owner.userId)))!.id).toBe(second.id);
    const read = await db.transaction((tx) => readW9(owner, tx, owner.userId, storage));
    expect(read.body.equals(PDF2)).toBe(true);
  });

  test("a W-9 must be a real PDF", async () => {
    const { db } = get();
    await expect(db.transaction((tx) => uploadW9(owner, tx, Buffer.from("MZ\x90 not a pdf"), "w9.pdf", storage))).rejects.toBeInstanceOf(ValidationError);
  });

  test("an .exe upload is rejected, as are mismatched bytes and oversize files", async () => {
    const { db } = get();
    const base = { kind: "attachment" as const, ownerUserId: owner.userId };
    const up = (filename: string, contentType: string, body: Buffer) =>
      db.transaction((tx) => uploadFile(coordinator, tx, { ...base, filename, contentType, body }, storage));
    await expect(up("a.exe", "application/x-msdownload", Buffer.from("MZ\x90\x00"))).rejects.toBeInstanceOf(ValidationError);
    await expect(up("a.pdf", "application/pdf", Buffer.from("MZ\x90\x00 pretending"))).rejects.toBeInstanceOf(ValidationError);
    await expect(up("big.pdf", "application/pdf", Buffer.concat([PDF, Buffer.alloc(20 * 1024 * 1024)]))).rejects.toBeInstanceOf(ValidationError);
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(8)]);
    const ok = await up("pic.png", "image/png", png);
    expect(ok.encrypted).toBe(false);
  });

  test("a refused type names the types the caller accepts", async () => {
    const { db } = get();
    const input = { kind: "attachment" as const, ownerUserId: owner.userId, filename: "a.doc", contentType: "application/msword", body: Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]) };
    const store = (only?: "pdf" | Array<"pdf" | "docx" | "doc">) => db.transaction((tx) => storeFile(coordinator, tx, input, { only }, storage));
    await expect(store()).rejects.toThrow(new ValidationError("Only PDF, DOCX, JPG and PNG files are allowed."));
    await expect(store("pdf")).rejects.toThrow(new ValidationError("Only PDF files are allowed."));
    await expect(store(["pdf"])).rejects.toThrow(new ValidationError("Only PDF files are allowed."));
    await expect(store(["pdf", "docx"])).rejects.toThrow(new ValidationError("Only PDF, DOCX files are allowed."));
    expect((await store(["pdf", "docx", "doc"])).contentType).toBe("application/msword");
  });

  test("the generic reader refuses a W-9 file id", async () => {
    const { db } = get();
    const w9 = (await db.transaction((tx) => currentW9(tx, owner.userId)))!;
    await expect(db.transaction((tx) => readStoredFile(tx, w9.fileId, storage))).rejects.toBeInstanceOf(NotFoundError);
  });

  test("a W-9 can never be stored unencrypted", async () => {
    const { db } = get();
    const input = { kind: "w9" as const, filename: "x.pdf", contentType: "application/pdf", body: PDF };
    const stored = await db.transaction((tx) => storeFile(owner, tx, input, {}, storage));
    expect(stored.encrypted).toBe(true);
    await expect(db.transaction((tx) => uploadFile(owner, tx, input, storage))).rejects.toBeInstanceOf(ValidationError);
    const [row] = await db.select().from(files).where(eq(files.id, (await db.transaction((tx) => currentW9(tx, owner.userId)))!.fileId));
    expect(row.encrypted).toBe(true);
  });

  test("a W-9 upload does not block rows that refer to the uploader while the file is being stored", async () => {
    const { db } = get();
    let release!: () => void;
    let started!: () => void;
    const putStarted = new Promise<void>((r) => (started = r));
    const slow: Storage = {
      put: async (k, b, c) => {
        started();
        await new Promise<void>((r) => (release = r));
        await storage.put(k, b, c);
      },
      get: (k) => storage.get(k),
    };
    const upload = db.transaction((tx) => uploadW9(owner, tx, PDF2, "w9.pdf", slow));
    await putStarted;
    try {
      // A foreign key check takes FOR KEY SHARE on the user row; FOR UPDATE held across the put would block it.
      const inserted = await db.transaction(async (tx) => {
        await tx.execute(sql`set local lock_timeout = '2s'`);
        return tx.insert(w9s).values({ userId: owner.userId, fileId: (await currentW9(tx, owner.userId))!.fileId, current: false }).returning({ userId: w9s.userId });
      });
      expect(inserted).toEqual([{ userId: owner.userId }]);
    } finally {
      release();
      await upload;
    }
  });

  test("W-9 filenames are never stored or audited; other names are capped", async () => {
    const { db } = get();
    const u = (await makeUser(db, "personnel", "named@example.test", {}, { w9: false })).actor;
    await db.transaction((tx) => uploadW9(u, tx, PDF, "Jane Doe 123-45-6789.pdf", storage));
    const fileRows = await db.select().from(files).where(eq(files.ownerUserId, u.userId));
    expect(fileRows[0].filename).toBe("W-9.pdf");
    const audits = await db.select().from(auditLog).where(eq(auditLog.actorUserId, u.userId));
    expect(JSON.stringify(audits)).not.toContain("Jane");
    const long = await db.transaction((tx) =>
      uploadFile(coordinator, tx, { kind: "attachment", filename: "a".repeat(400) + ".pdf", contentType: "application/pdf", body: PDF }, storage),
    );
    expect(long.filename).toHaveLength(255);
  });

  test("concurrent W-9 uploads leave exactly one current row", async () => {
    const { db } = get();
    const u = (await makeUser(db, "personnel", "race@example.test", {}, { w9: false })).actor;
    await Promise.all([
      db.transaction((tx) => uploadW9(u, tx, PDF, "a.pdf", storage)),
      db.transaction((tx) => uploadW9(u, tx, PDF2, "b.pdf", storage)),
    ]);
    const rows = await db.select().from(w9s).where(eq(w9s.userId, u.userId));
    expect(rows).toHaveLength(2);
    expect(rows.filter((r) => r.current)).toHaveLength(1);
  });
});
