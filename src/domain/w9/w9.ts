import { and, eq } from "drizzle-orm";
import type { Tx } from "@/db/client";
import { files, invoices, users, w9s } from "@/db/schema";
import type { Actor } from "@/domain/actor";
import { recordAudit } from "@/domain/audit/audit";
import { assertCan } from "@/domain/auth/policy";
import { NotFoundError } from "@/domain/errors";
import { storeFile } from "@/domain/files/files";
import { decryptFile, masterKeyFromEnv } from "@/lib/crypto/envelope";
import { getStorage, type Storage } from "@/lib/storage";

export type W9Row = typeof w9s.$inferSelect;

export async function currentW9(tx: Tx, userId: string): Promise<W9Row | null> {
  const [row] = await tx.select().from(w9s).where(and(eq(w9s.userId, userId), eq(w9s.current, true)));
  return row ?? null;
}

/** Uploads the actor's own W-9 (PDF only, encrypted). Earlier W-9s stay as history, not current. */
export async function uploadW9(actor: Actor, tx: Tx, body: Buffer, filename: string, storage?: Storage): Promise<W9Row> {
  assertCan(actor, "w9.uploadOwn", { ownerUserId: actor.userId });
  // Serialize uploads per user so exactly one W-9 is current. FOR NO KEY UPDATE, not FOR UPDATE: it is held across
  // the storage put, and must not block the foreign key checks of rows that refer to this user meanwhile.
  await tx.select({ id: users.id }).from(users).where(eq(users.id, actor.userId)).for("no key update");
  const file = await storeFile(
    actor,
    tx,
    { kind: "w9", filename, contentType: "application/pdf", body, ownerUserId: actor.userId },
    { only: "pdf" },
    storage,
  );
  const previous = await currentW9(tx, actor.userId);
  if (previous) await tx.update(w9s).set({ current: false }).where(eq(w9s.id, previous.id));
  const [row] = await tx.insert(w9s).values({ userId: actor.userId, fileId: file.id, current: true }).returning();
  await recordAudit(tx, {
    actor,
    action: "w9.upload",
    entityType: "w9",
    entityId: row.id,
    before: previous ? { w9Id: previous.id, current: true } : null,
    after: { userId: row.userId, fileId: file.id, current: true },
  });
  return row;
}

/** Owner, coordinators and admins. Every read is audited; the audit row holds no file content. */
export async function readW9(
  actor: Actor,
  tx: Tx,
  userId: string,
  storage?: Storage,
): Promise<{ filename: string; body: Buffer; uploadedAt: Date }> {
  assertCan(actor, "w9.read", { ownerUserId: userId });
  const w9 = await currentW9(tx, userId);
  if (!w9) throw new NotFoundError("No W-9 on file.");
  const [row] = await tx.select().from(files).where(eq(files.id, w9.fileId));
  if (!row) throw new NotFoundError("No W-9 on file.");
  const body = decryptFile(await (storage ?? getStorage()).get(row.storageKey), masterKeyFromEnv());
  await recordAudit(tx, {
    actor,
    action: "w9.read",
    entityType: "w9",
    entityId: w9.id,
    after: { userId, fileId: w9.fileId },
  });
  return { filename: row.filename, body, uploadedAt: w9.uploadedAt };
}

/**
 * For the worker building an invoice email: the payee's current W-9, only for an invoice marked
 * attachW9. Audited as `requesterUserId` (the coordinator who asked for it) when given, else the system
 * actor. Not an authorization path for anything else.
 */
export async function readW9ForInvoiceEmail(
  tx: Tx,
  invoiceId: string,
  storage?: Storage,
  requesterUserId?: string,
): Promise<{ filename: string; body: Buffer }> {
  const [inv] = await tx
    .select({ payeeUserId: invoices.payeeUserId, attachW9: invoices.attachW9 })
    .from(invoices)
    .where(eq(invoices.id, invoiceId));
  if (!inv?.attachW9) throw new NotFoundError("This invoice does not attach a W-9.");
  const w9 = await currentW9(tx, inv.payeeUserId);
  if (!w9) throw new NotFoundError("No W-9 on file.");
  const [row] = await tx.select().from(files).where(eq(files.id, w9.fileId));
  if (!row) throw new NotFoundError("No W-9 on file.");
  const body = decryptFile(await (storage ?? getStorage()).get(row.storageKey), masterKeyFromEnv());
  let actor: Actor | "system" = "system";
  if (requesterUserId) {
    const [u] = await tx.select({ role: users.role, rankId: users.rankId }).from(users).where(eq(users.id, requesterUserId));
    if (u) actor = { userId: requesterUserId, role: u.role, rankId: u.rankId, vendorId: null };
  }
  await recordAudit(tx, {
    actor,
    action: "w9.read",
    entityType: "w9",
    entityId: w9.id,
    after: { userId: inv.payeeUserId, fileId: w9.fileId, invoiceId },
  });
  return { filename: row.filename, body };
}
