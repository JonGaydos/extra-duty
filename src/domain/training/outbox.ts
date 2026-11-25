import { desc } from "drizzle-orm";
import type { Tx } from "@/db/client";
import { trainingOutbox } from "@/db/schema";
import type { Actor } from "@/domain/actor";
import { assertCan } from "@/domain/auth/policy";

export type OutboxRow = typeof trainingOutbox.$inferSelect;

export const OUTBOX_PAGE_SIZE = 100;

/** The newest messages the app kept instead of sending (training mode, or staging). Coordinators and admins. */
export async function listOutbox(actor: Actor, tx: Tx, limit = OUTBOX_PAGE_SIZE): Promise<OutboxRow[]> {
  assertCan(actor, "training.outbox");
  return tx.select().from(trainingOutbox).orderBy(desc(trainingOutbox.createdAt)).limit(limit);
}
