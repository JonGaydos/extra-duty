import type { Tx } from "@/db/client";
import type { Actor } from "../actor";
import { assertCan } from "../auth/policy";
import { NotFoundError, ValidationError } from "../errors";
import { assignments } from "@/db/schema";
import { eq } from "drizzle-orm";
import { leaveAssignment, type LeaveOptions } from "./backups";
import type { Assignment } from "./signup";

export { claimSpot } from "./backups";

const STARTED = "This detail has started. Ask a coordinator to remove you.";
const GIVE_AWAY = "You are signed up for this spot. Give it away instead: you stay on the detail until another deputy takes it.";

/**
 * Leaves a backup place or withdraws a pending shorter request before the job starts. A signed-up deputy is never
 * removed this way: they give the spot away (offerSpot) and stay on it until someone takes it over (owner decision
 * 2026-11-27).
 */
export async function cancelSignup(actor: Actor, tx: Tx, assignmentId: string, reason: string, now: Date = new Date()): Promise<Assignment> {
  const [row] = await tx.select().from(assignments).where(eq(assignments.id, assignmentId));
  if (!row) throw new NotFoundError("Assignment not found.");
  assertCan(actor, "assignment.cancelOwn", { ownerUserId: row.userId });
  const why = reason?.trim();
  if (!why) throw new ValidationError("A reason is required.");
  const opts: LeaveOptions = {
    status: "canceled",
    auditAction: "assignment.cancel",
    reason: why,
    now,
    guard: (before, job) => {
      if (before.status === "signed_up") throw new ValidationError(GIVE_AWAY);
      if (now.getTime() >= job.startAt.getTime()) throw new ValidationError(STARTED);
    },
  };
  return leaveAssignment(actor, tx, assignmentId, opts);
}
