import { and, eq } from "drizzle-orm";
import { liveDb, runnerFor, trainingConfigured, type DataMode, type Tx, type TxRunner } from "@/db/client";
import { sessions, users } from "@/db/schema";
import type { Actor } from "@/domain/actor";
import { recordAudit } from "@/domain/audit/audit";
import { assertCan, can } from "@/domain/auth/policy";
import { loadActiveActor } from "@/domain/auth/sign-in-policy";
import { ValidationError } from "@/domain/errors";

export { type DataMode } from "@/db/client";

export type PracticeRole = "deputy" | "coordinator" | "admin" | "vendor";
const PRACTICE_ROLES: readonly PracticeRole[] = ["deputy", "coordinator", "admin", "vendor"];
export const PRACTICE_ROLE_LABELS: Record<PracticeRole, string> = { deputy: "Deputy", coordinator: "Coordinator", admin: "Admin", vendor: "Vendor" };

/** The demo account each practice role signs in as, in the training database (created by the demo seed). */
export const PRACTICE_USER_EMAILS: Record<PracticeRole, string> = {
  deputy: "deputy@training.example",
  coordinator: "coordinator@training.example",
  admin: "admin@training.example",
  vendor: "vendor@training.example",
};

/**
 * One request's data source, settled once at its start. `user` is the signed-in person (live). `actor` is who the
 * work runs as: the user, or in training the demo user for `practiceRole`. `run` is the only way the request
 * reaches a database; a mode change during the request does not affect it.
 */
export type RequestContext = {
  sessionId: string;
  user: Actor;
  actor: Actor;
  mode: DataMode;
  practiceRole: PracticeRole | null;
  run: TxRunner;
};

/** The demo user for `role` in the current (training) transaction, or null if the demo data is not loaded. */
export async function practiceActor(tx: Tx, role: PracticeRole): Promise<Actor | null> {
  const [u] = await tx.select({ id: users.id }).from(users).where(eq(users.email, PRACTICE_USER_EMAILS[role]));
  return u ? loadActiveActor(tx, u.id) : null;
}

/**
 * The context for a signed-in session (null when the person is not active). Training applies only to coordinators
 * and admins, only where a training database is configured, and only while its demo user exists; anything else is
 * live.
 */
export async function contextForSession(session: { id: string; userId: string }): Promise<RequestContext | null> {
  const { user, row } = await liveDb.transaction(async (tx) => ({
    user: await loadActiveActor(tx, session.userId),
    row: (await tx.select({ mode: sessions.mode, practiceRole: sessions.practiceRole }).from(sessions).where(eq(sessions.id, session.id)))[0],
  }));
  if (!user || !row) return null;
  if (row.mode === "training" && row.practiceRole && can(user, "training.switch") && trainingConfigured()) {
    const run = runnerFor("training");
    const actor = await run((tx) => practiceActor(tx, row.practiceRole!));
    if (actor) return { sessionId: session.id, user, actor, mode: "training", practiceRole: row.practiceRole, run };
  }
  return { sessionId: session.id, user, actor: user, mode: "live", practiceRole: null, run: runnerFor("live") };
}

/**
 * Switches the signed-in session to training (practicing as `practiceRole`) or back to live. Coordinators and admins
 * only; `tx` is a live transaction (sessions live there). Audited.
 */
export async function switchMode(user: Actor, tx: Tx, sessionId: string, mode: DataMode, practiceRole?: PracticeRole): Promise<void> {
  assertCan(user, "training.switch");
  let role: PracticeRole | null = null;
  if (mode === "training") {
    if (!trainingConfigured()) throw new ValidationError("Training mode is not set up on this site.");
    if (!practiceRole || !PRACTICE_ROLES.includes(practiceRole)) throw new ValidationError("Choose a role to practice as.");
    const demo = await runnerFor("training")((ttx) => practiceActor(ttx, practiceRole));
    if (!demo) throw new ValidationError("The training data is not loaded yet. Try again after the nightly reset, or ask an admin.");
    role = practiceRole;
  }
  const [before] = await tx
    .select({ mode: sessions.mode, practiceRole: sessions.practiceRole })
    .from(sessions)
    .where(and(eq(sessions.id, sessionId), eq(sessions.userId, user.userId)));
  if (!before) throw new ValidationError("The session has ended. Sign in again.");
  await tx.update(sessions).set({ mode, practiceRole: role }).where(eq(sessions.id, sessionId));
  await recordAudit(tx, {
    actor: user,
    action: "training.switch",
    entityType: "session",
    entityId: sessionId,
    before,
    after: { mode, practiceRole: role },
  });
}
