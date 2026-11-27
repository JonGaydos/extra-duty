import { and, asc, desc, eq, inArray, notExists, sql } from "drizzle-orm";
import type { Tx } from "@/db/client";
import { auditLog, files, invoices, users, vendors, w9s } from "@/db/schema";
import type { Actor } from "@/domain/actor";
import { recordAudit } from "@/domain/audit/audit";
import { assertCan } from "@/domain/auth/policy";
import { NotFoundError, ValidationError } from "@/domain/errors";
import { storeFile } from "@/domain/files/files";
import { emit } from "@/domain/notifications/notify";
import { agencyDateParts, agencyDayKey } from "@/domain/time/agency-time";
import { decryptFile, masterKeyFromEnv } from "@/lib/crypto/envelope";
import { getStorage, type Storage } from "@/lib/storage";

export type W9Row = typeof w9s.$inferSelect;

/** IRS form revisions offered at approval; any other revision can be typed. */
export const W9_FORM_REVISIONS = ["March 2024", "October 2018"] as const;
const MAX_REVISION = 40;
const MAX_REASON = 500;

/** The person's latest upload, whatever its review status. */
export async function currentW9(tx: Tx, userId: string): Promise<W9Row | null> {
  const [row] = await tx.select().from(w9s).where(and(eq(w9s.userId, userId), eq(w9s.current, true)));
  return row ?? null;
}

/** The W-9 that counts: the newest approved one. A newer pending or rejected upload does not replace it. */
export async function approvedW9(tx: Tx, userId: string): Promise<W9Row | null> {
  const [row] = await tx
    .select()
    .from(w9s)
    .where(and(eq(w9s.userId, userId), eq(w9s.status, "approved")))
    .orderBy(desc(w9s.uploadedAt), desc(w9s.id))
    .limit(1);
  return row ?? null;
}

/** Each person's newest approved W-9, for many people at once. */
export async function approvedW9s(tx: Tx, userIds: string[]): Promise<Map<string, W9Row>> {
  const out = new Map<string, W9Row>();
  if (userIds.length === 0) return out;
  const rows = await tx
    .select()
    .from(w9s)
    .where(and(inArray(w9s.userId, userIds), eq(w9s.status, "approved")))
    .orderBy(desc(w9s.uploadedAt), desc(w9s.id));
  for (const r of rows) if (!out.has(r.userId)) out.set(r.userId, r);
  return out;
}

/** Whether a signature date falls in the current calendar year, agency time. Unknown never does. */
export function signedThisYear(signedOn: string | null, now: Date): boolean {
  return signedOn !== null && signedOn.slice(0, 4) === String(agencyDateParts(now).year);
}

export type AttachableW9 = { w9: W9Row; problem: null } | { w9: null; problem: "none" | "not_current_year"; approved: W9Row | null };

/**
 * The W-9 an invoice to this vendor may carry: the payee's newest approved one, and, when the vendor requires it,
 * only if it was signed this calendar year. Never a pending, rejected or superseded W-9.
 */
export function attachableFrom(approved: W9Row | null, requiresCurrentYear: boolean, now: Date): AttachableW9 {
  if (!approved) return { w9: null, problem: "none", approved: null };
  if (requiresCurrentYear && !signedThisYear(approved.signedOn, now)) return { w9: null, problem: "not_current_year", approved };
  return { w9: approved, problem: null };
}

export async function attachableW9(tx: Tx, userId: string, vendorId: string, now: Date = new Date()): Promise<AttachableW9> {
  const [v] = await tx.select({ requires: vendors.requiresCurrentYearW9 }).from(vendors).where(eq(vendors.id, vendorId));
  return attachableFrom(await approvedW9(tx, userId), v?.requires ?? false, now);
}

/**
 * For a vendor that needs a W-9 signed this year, the plain notice when the payee's approved W-9 is older (or has no
 * known signature date), else null. `who` is "Your" for the payee or their name for staff. Billing is never blocked.
 */
export function currentYearNotice(a: AttachableW9, who: string, now: Date): string | null {
  if (a.problem !== "not_current_year") return null;
  const year = agencyDateParts(now).year;
  const signed = a.approved?.signedOn ? `was signed ${dayText(a.approved.signedOn)}` : "has no known signature date";
  const whose = who === "Your" ? "Your" : `${who}'s`;
  return `This vendor needs a W-9 signed in ${year}. ${whose} approved W-9 ${signed}, so it will not be attached. Upload a new W-9 to fix this.`;
}

/** Stores a W-9 for `userId` as their latest upload, pending review. Earlier W-9s stay as history. */
async function storeW9(actor: Actor, tx: Tx, userId: string, body: Buffer, storage: Storage | undefined): Promise<W9Row> {
  // Serialize uploads per user so exactly one W-9 is current. FOR NO KEY UPDATE, not FOR UPDATE: it is held across
  // the storage put, and must not block the foreign key checks of rows that refer to this user meanwhile.
  const [person] = await tx.select({ id: users.id, role: users.role }).from(users).where(eq(users.id, userId)).for("no key update");
  if (!person || person.role === "vendor") throw new NotFoundError("Person not found.");
  const file = await storeFile(actor, tx, { kind: "w9", filename: "W-9.pdf", contentType: "application/pdf", body, ownerUserId: userId }, { only: "pdf" }, storage);
  const previous = await currentW9(tx, userId);
  if (previous) await tx.update(w9s).set({ current: false }).where(eq(w9s.id, previous.id));
  const uploadedBy = actor.userId === userId ? null : actor.userId;
  const [row] = await tx.insert(w9s).values({ userId, fileId: file.id, current: true, status: "pending", uploadedBy }).returning();
  await recordAudit(tx, {
    actor,
    action: "w9.upload",
    entityType: "w9",
    entityId: row.id,
    before: previous ? { w9Id: previous.id, current: true } : null,
    after: { userId, fileId: file.id, current: true, status: "pending", uploadedBy },
  });
  return row;
}

/** Uploads the actor's own W-9 (PDF only, encrypted). It waits for staff review. */
export async function uploadW9(actor: Actor, tx: Tx, body: Buffer, _filename: string, storage?: Storage): Promise<W9Row> {
  assertCan(actor, "w9.uploadOwn", { ownerUserId: actor.userId });
  return storeW9(actor, tx, actor.userId, body, storage);
}

/** Staff upload a W-9 for a person (same storage and encryption). It waits for review like any other. */
export async function uploadW9For(actor: Actor, tx: Tx, userId: string, body: Buffer, storage?: Storage): Promise<W9Row> {
  assertCan(actor, "w9.uploadFor");
  return storeW9(actor, tx, userId, body, storage);
}

export type W9Review = { decision: "approve"; signedOn: string; formRevision: string } | { decision: "reject"; reason: string };

function checkApproval(input: { signedOn?: unknown; formRevision?: unknown }, now: Date): { signedOn: string; formRevision: string } {
  const signedOn = typeof input.signedOn === "string" ? input.signedOn.trim() : "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(signedOn) || Number.isNaN(Date.parse(`${signedOn}T12:00:00Z`))) throw new ValidationError("Enter the date the W-9 was signed.");
  if (signedOn > agencyDayKey(now)) throw new ValidationError("The signature date cannot be in the future.");
  const formRevision = typeof input.formRevision === "string" ? input.formRevision.trim() : "";
  if (!formRevision) throw new ValidationError("Enter the IRS form revision, such as March 2024.");
  if (formRevision.length > MAX_REVISION) throw new ValidationError(`The form revision can be at most ${MAX_REVISION} characters.`);
  return { signedOn, formRevision };
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "2026-01-31" as "Jan 31, 2026". */
export function dayText(key: string): string {
  const [y, m, d] = key.split("-").map(Number);
  return `${MONTHS[m - 1]} ${d}, ${y}`;
}

/**
 * Approves a pending W-9 with its signature date and IRS form revision, or rejects it with a reason. The person is
 * told either way (a rejection says why and links to the upload). Audited with before and after.
 */
export async function reviewW9(actor: Actor, tx: Tx, w9Id: string, input: W9Review, now: Date = new Date()): Promise<W9Row> {
  assertCan(actor, "w9.review");
  const [w9] = typeof w9Id === "string" ? await tx.select().from(w9s).where(eq(w9s.id, w9Id)).for("update") : [];
  if (!w9) throw new NotFoundError("W-9 not found.");
  if (w9.status !== "pending") throw new ValidationError("This W-9 was already reviewed.");
  let patch: Partial<W9Row>;
  if (input?.decision === "approve") {
    patch = { status: "approved", ...checkApproval(input, now), rejectReason: null };
  } else if (input?.decision === "reject") {
    const reason = typeof input.reason === "string" ? input.reason.trim() : "";
    if (!reason) throw new ValidationError("Give a reason, such as Line 2 missing or Not signed.");
    if (reason.length > MAX_REASON) throw new ValidationError(`The reason can be at most ${MAX_REASON} characters.`);
    patch = { status: "rejected", rejectReason: reason };
  } else {
    throw new ValidationError("Choose Approve or Reject.");
  }
  const [row] = await tx
    .update(w9s)
    .set({ ...patch, reviewedBy: actor.userId, reviewedAt: now })
    .where(eq(w9s.id, w9.id))
    .returning();
  const snap = (r: W9Row) => ({ status: r.status, signedOn: r.signedOn, formRevision: r.formRevision, rejectReason: r.rejectReason });
  await recordAudit(tx, {
    actor,
    action: row.status === "approved" ? "w9.approve" : "w9.reject",
    entityType: "w9",
    entityId: row.id,
    before: snap(w9),
    after: { userId: row.userId, ...snap(row) },
    reason: row.rejectReason ?? undefined,
  });
  if (row.status === "approved") {
    await emit(tx, { type: "w9.approved", recipients: [row.userId], title: "W-9 approved", body: `Your W-9 signed ${dayText(row.signedOn!)} is approved.`, link: "/profile#w9" }, now);
  } else {
    await emit(tx, { type: "w9.rejected", recipients: [row.userId], title: "W-9 not approved", body: `Your W-9 was not approved: ${row.rejectReason}. Upload a new one in Profile.`, link: "/profile#w9" }, now);
  }
  return row;
}

export type W9HistoryRow = W9Row & { uploadedByName: string | null; reviewedByName: string | null };

/** Every W-9 a person has uploaded, newest first, with who uploaded and reviewed each. Never the file. */
export async function w9History(actor: Actor, tx: Tx, userId: string): Promise<W9HistoryRow[]> {
  assertCan(actor, "w9.read", { ownerUserId: userId });
  const uploader = sql<string | null>`(select name from users u where u.id = ${w9s.uploadedBy})`;
  const reviewer = sql<string | null>`(select name from users u where u.id = ${w9s.reviewedBy})`;
  const rows = await tx
    .select({ w9: w9s, uploadedByName: uploader, reviewedByName: reviewer })
    .from(w9s)
    .where(eq(w9s.userId, userId))
    .orderBy(desc(w9s.uploadedAt), desc(w9s.id));
  return rows.map((r) => ({ ...r.w9, uploadedByName: r.uploadedByName, reviewedByName: r.reviewedByName }));
}

export type PendingW9 = { w9Id: string; userId: string; name: string; uploadedAt: Date; uploadedByName: string | null };

/** Latest uploads waiting for review, oldest first: the To-do's "W-9 to review". */
export async function pendingW9Reviews(tx: Tx): Promise<PendingW9[]> {
  const uploader = sql<string | null>`(select name from users u where u.id = ${w9s.uploadedBy})`;
  return tx
    .select({ w9Id: w9s.id, userId: w9s.userId, name: users.name, uploadedAt: w9s.uploadedAt, uploadedByName: uploader })
    .from(w9s)
    .innerJoin(users, eq(users.id, w9s.userId))
    .where(and(eq(w9s.current, true), eq(w9s.status, "pending"), eq(users.active, true)))
    .orderBy(asc(w9s.uploadedAt), asc(w9s.id));
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
 * For the worker building an invoice email: the W-9 the invoice may carry (attachableW9), only for an invoice marked
 * attachW9; null when there is none to attach (not approved, or not signed this year for a vendor that needs it).
 * Audited as `requesterUserId` (the coordinator who asked for it) when given, else the system actor. Not an
 * authorization path for anything else.
 */
export async function readW9ForInvoiceEmail(
  tx: Tx,
  invoiceId: string,
  storage?: Storage,
  requesterUserId?: string,
  now: Date = new Date(),
): Promise<{ filename: string; body: Buffer } | null> {
  const [inv] = await tx
    .select({ payeeUserId: invoices.payeeUserId, vendorId: invoices.vendorId, attachW9: invoices.attachW9 })
    .from(invoices)
    .where(eq(invoices.id, invoiceId));
  if (!inv?.attachW9) throw new NotFoundError("This invoice does not attach a W-9.");
  const { w9 } = await attachableW9(tx, inv.payeeUserId, inv.vendorId, now);
  if (!w9) return null;
  const [row] = await tx.select().from(files).where(eq(files.id, w9.fileId));
  if (!row) return null;
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

const GRANDFATHER_REASON = "Owner decision 2026-11-27: W-9s on file when review began are approved, signature date unknown.";

/**
 * Release step: a system audit entry for each W-9 the migration grandfathered as approved. Safe to run again: a W-9
 * that already has its entry is skipped. Returns the count written.
 */
export async function auditGrandfatheredW9s(tx: Tx): Promise<number> {
  const rows = await tx
    .select({ id: w9s.id, userId: w9s.userId })
    .from(w9s)
    .where(
      and(
        eq(w9s.grandfathered, true),
        notExists(tx.select({ x: auditLog.id }).from(auditLog).where(and(eq(auditLog.action, "w9.grandfather"), eq(auditLog.entityType, "w9"), eq(auditLog.entityId, w9s.id)))),
      ),
    )
    .orderBy(asc(w9s.id));
  // Sequential: audit writes in this transaction.
  for (const r of rows) {
    await recordAudit(tx, { actor: "system", action: "w9.grandfather", entityType: "w9", entityId: r.id, before: { status: "none" }, after: { userId: r.userId, status: "approved", signedOn: null }, reason: GRANDFATHER_REASON });
  }
  return rows.length;
}


/**
 * For a vendor that needs a W-9 signed this year: payees with an invoice to it not yet closed whose approved W-9 is
 * older (or has no known signature date, or is missing). Their invoices go without a W-9. Staff only.
 */
export async function vendorW9Gaps(actor: Actor, tx: Tx, vendorId: string, now: Date = new Date()): Promise<Array<{ userId: string; name: string; signedOn: string | null }>> {
  assertCan(actor, "invoice.review");
  const [v] = await tx.select({ requires: vendors.requiresCurrentYearW9 }).from(vendors).where(eq(vendors.id, vendorId));
  if (!v?.requires) return [];
  const payees = await tx
    .selectDistinct({ userId: invoices.payeeUserId, name: users.name })
    .from(invoices)
    .innerJoin(users, eq(users.id, invoices.payeeUserId))
    .where(and(eq(invoices.vendorId, vendorId), inArray(invoices.status, ["pending_review", "approved_unsent", "ready_to_send", "sent"])))
    .orderBy(asc(users.name));
  const approved = await approvedW9s(tx, payees.map((p) => p.userId));
  return payees
    .map((p) => ({ ...p, w9: approved.get(p.userId) ?? null }))
    .filter((p) => !p.w9 || !signedThisYear(p.w9.signedOn, now))
    .map((p) => ({ userId: p.userId, name: p.name, signedOn: p.w9?.signedOn ?? null }));
}
