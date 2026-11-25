import { and, desc, eq, gte, lte, type SQL } from "drizzle-orm";
import type { Tx } from "@/db/client";
import { auditLog } from "@/db/schema";
import type { Actor } from "../actor";
import { ForbiddenError } from "../errors";

export const AUDIT_PAGE_SIZE = 50;

export type AuditRow = typeof auditLog.$inferSelect;

export type AuditEntry = {
  actor: Actor | "system";
  action: string;
  entityType: string;
  entityId: string;
  before?: unknown;
  after?: unknown;
  reason?: string;
};

export async function recordAudit(tx: Tx, e: AuditEntry): Promise<void> {
  await tx.insert(auditLog).values({
    actorUserId: e.actor === "system" ? null : e.actor.userId,
    action: e.action,
    entityType: e.entityType,
    entityId: e.entityId,
    before: e.before ?? null,
    after: e.after ?? null,
    reason: e.reason ?? null,
    at: new Date(),
  });
}

export type AuditFilter = { entityType?: string; entityId?: string; from?: Date; to?: Date };

/** Coordinators and admins only. Newest first, 50 rows per page (page is 1-based). */
export async function listAudit(actor: Actor, tx: Tx, filter: AuditFilter, page: number): Promise<AuditRow[]> {
  if (actor.role !== "admin" && actor.role !== "coordinator") {
    throw new ForbiddenError("Only coordinators and admins can read the audit log.");
  }
  const conds: SQL[] = [];
  if (filter.entityType) conds.push(eq(auditLog.entityType, filter.entityType));
  if (filter.entityId) conds.push(eq(auditLog.entityId, filter.entityId));
  if (filter.from) conds.push(gte(auditLog.at, filter.from));
  if (filter.to) conds.push(lte(auditLog.at, filter.to));
  const p = Math.max(1, Math.floor(page));
  return tx
    .select()
    .from(auditLog)
    .where(and(...conds))
    .orderBy(desc(auditLog.at), desc(auditLog.id))
    .limit(AUDIT_PAGE_SIZE)
    .offset((p - 1) * AUDIT_PAGE_SIZE);
}
