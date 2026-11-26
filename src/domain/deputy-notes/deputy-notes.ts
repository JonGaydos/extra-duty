import { and, asc, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import type { Tx } from "@/db/client";
import { assignments, deputyNotes, jobs, users } from "@/db/schema";
import type { Actor } from "@/domain/actor";
import { recordAudit } from "@/domain/audit/audit";
import { assertCan } from "@/domain/auth/policy";
import { ForbiddenError, NotFoundError, ValidationError } from "@/domain/errors";
import { coordinatorAudience } from "@/domain/notifications/audiences";
import { emit } from "@/domain/notifications/notify";

export type DeputyNote = typeof deputyNotes.$inferSelect;
export const DEPUTY_NOTE_MAX = 2000;

function cleanBody(raw: string | undefined): string {
  const body = (raw ?? "").trim();
  if (body.length < 1) throw new ValidationError("Enter the note.");
  if (body.length > DEPUTY_NOTE_MAX) throw new ValidationError(`A note can be at most ${DEPUTY_NOTE_MAX.toLocaleString("en-US")} characters.`);
  return body;
}

const snapshot = (n: DeputyNote) => ({ status: n.status, body: n.body, vendorId: n.vendorId, locationId: n.locationId });

async function lockNote(tx: Tx, noteId: string): Promise<DeputyNote> {
  const [note] = await tx.select().from(deputyNotes).where(eq(deputyNotes.id, noteId)).for("update");
  if (!note) throw new NotFoundError("Note not found.");
  return note;
}

/**
 * A person signed up, billed or paid on the job passes on what they learned, for the vendor as a whole or for
 * the job's location, once the job has started. The note is `pending` until a coordinator reviews it, and
 * coordinators are alerted.
 */
export async function submitDeputyNote(
  actor: Actor,
  tx: Tx,
  input: { jobId: string; body: string; scope: "vendor" | "location" },
  now: Date = new Date(),
): Promise<DeputyNote> {
  assertCan(actor, "deputyNote.submit");
  if (input.scope !== "vendor" && input.scope !== "location") throw new ValidationError("Choose whether the note is for the vendor or the location.");
  const body = cleanBody(input.body);
  const [job] = await tx.select().from(jobs).where(eq(jobs.id, input.jobId));
  if (!job) throw new NotFoundError("Job not found.");
  const [mine] = await tx
    .select({ id: assignments.id })
    .from(assignments)
    .where(and(eq(assignments.jobId, job.id), eq(assignments.userId, actor.userId), inArray(assignments.status, ["signed_up", "billed", "paid"])))
    .limit(1);
  if (!mine) throw new ForbiddenError("Only a person working this detail can add a note.");
  if (now.getTime() < job.startAt.getTime()) throw new ValidationError("You can add a note once the detail has started.");
  if (input.scope === "location" && !job.locationId) throw new ValidationError("This detail has no location to attach the note to.");

  const [note] = await tx
    .insert(deputyNotes)
    .values({
      vendorId: job.vendorId,
      locationId: input.scope === "location" ? job.locationId : null,
      body,
      status: "pending",
      submittedBy: actor.userId,
      submittedFromJobId: job.id,
      submittedAt: now,
    })
    .returning();
  await recordAudit(tx, { actor, action: "deputy_note.submit", entityType: "deputy_note", entityId: note.id, before: null, after: snapshot(note) });
  const [author] = await tx.select({ name: users.name }).from(users).where(eq(users.id, actor.userId));
  await emit(
    tx,
    {
      recipients: (await coordinatorAudience(tx)).filter((id) => id !== actor.userId),
      type: "deputyNote.submitted",
      title: `Deputy note to review: job #${job.number}`,
      body: `${author?.name ?? "A deputy"} submitted a note from ${job.title}.`,
      link: `/jobs/${job.id}`,
    },
    now,
  );
  return note;
}

/**
 * A coordinator or admin approves (optionally with reworded text) or denies a pending note. The author is
 * alerted either way. Denying takes an optional reason.
 */
export async function reviewDeputyNote(
  actor: Actor,
  tx: Tx,
  noteId: string,
  input: { decision: "approve" | "deny"; editedBody?: string; comment?: string },
  now: Date = new Date(),
): Promise<DeputyNote> {
  assertCan(actor, "deputyNote.manage");
  if (input.decision !== "approve" && input.decision !== "deny") throw new ValidationError("Choose approve or deny.");
  const comment = input.comment?.trim() || null;
  if (comment && comment.length > DEPUTY_NOTE_MAX) throw new ValidationError(`A comment can be at most ${DEPUTY_NOTE_MAX.toLocaleString("en-US")} characters.`);
  const note = await lockNote(tx, noteId);
  if (note.status !== "pending") throw new ValidationError("This note was already reviewed.");
  const approve = input.decision === "approve";
  const body = approve && input.editedBody !== undefined ? cleanBody(input.editedBody) : note.body;
  const [done] = await tx
    .update(deputyNotes)
    .set({ status: approve ? "approved" : "denied", body, reviewedBy: actor.userId, reviewedAt: now, reviewComment: comment })
    .where(eq(deputyNotes.id, note.id))
    .returning();
  await recordAudit(tx, {
    actor,
    action: "deputy_note.review",
    entityType: "deputy_note",
    entityId: note.id,
    before: snapshot(note),
    after: { ...snapshot(done), comment },
  });
  const reason = comment ? ` Reason: ${comment}` : "";
  await emit(
    tx,
    {
      recipients: [note.submittedBy],
      type: approve ? "deputyNote.approved" : "deputyNote.denied",
      title: approve ? "Your note was approved" : "Your note was not approved",
      body: approve ? "Your deputy note will show on future details." : `Your deputy note was not approved.${reason}`,
      link: `/jobs/${note.submittedFromJobId}`,
    },
    now,
  );
  return done;
}

/** Coordinators and admins reword a pending or approved note. The author and the date written stay as they were. */
export async function editDeputyNote(actor: Actor, tx: Tx, noteId: string, input: { body: string }): Promise<DeputyNote> {
  assertCan(actor, "deputyNote.manage");
  const body = cleanBody(input.body);
  const note = await lockNote(tx, noteId);
  if (note.status !== "pending" && note.status !== "approved") throw new ValidationError("Only a pending or approved note can be edited.");
  const [done] = await tx.update(deputyNotes).set({ body }).where(eq(deputyNotes.id, note.id)).returning();
  await recordAudit(tx, { actor, action: "deputy_note.edit", entityType: "deputy_note", entityId: note.id, before: snapshot(note), after: snapshot(done) });
  return done;
}

/** Coordinators and admins stop an approved note from showing. The row stays as history. */
export async function retireDeputyNote(actor: Actor, tx: Tx, noteId: string): Promise<DeputyNote> {
  assertCan(actor, "deputyNote.manage");
  const note = await lockNote(tx, noteId);
  if (note.status !== "approved") throw new ValidationError("Only an approved note can be retired.");
  const [done] = await tx.update(deputyNotes).set({ status: "retired" }).where(eq(deputyNotes.id, note.id)).returning();
  await recordAudit(tx, { actor, action: "deputy_note.retire", entityType: "deputy_note", entityId: note.id, before: snapshot(note), after: snapshot(done) });
  return done;
}

export type JobDeputyNote = { body: string; authorName: string; writtenAt: Date };

/**
 * Approved notes for the job's vendor and its location: location notes first, then vendor-wide, newest written
 * first within each. Personnel, coordinators and admins; vendors never see deputy notes.
 */
export async function deputyNotesForJob(actor: Actor, tx: Tx, jobId: string): Promise<JobDeputyNote[]> {
  if (actor.role === "vendor") throw new ForbiddenError();
  assertCan(actor, "job.read");
  const [job] = await tx.select({ vendorId: jobs.vendorId, locationId: jobs.locationId }).from(jobs).where(eq(jobs.id, jobId));
  if (!job) throw new NotFoundError("Job not found.");
  const scope = job.locationId ? or(isNull(deputyNotes.locationId), eq(deputyNotes.locationId, job.locationId))! : isNull(deputyNotes.locationId);
  const rows = await tx
    .select({ body: deputyNotes.body, authorName: users.name, writtenAt: deputyNotes.submittedAt })
    .from(deputyNotes)
    .innerJoin(users, eq(users.id, deputyNotes.submittedBy))
    .where(and(eq(deputyNotes.vendorId, job.vendorId), eq(deputyNotes.status, "approved"), scope))
    .orderBy(sql`(${deputyNotes.locationId} is null)`, desc(deputyNotes.submittedAt), asc(deputyNotes.id));
  return rows;
}
