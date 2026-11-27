import { users } from "@/db/schema";
import type { Db } from "@/db/client";
import type { Actor, Role } from "@/domain/actor";
import { giveApprovedW9 } from "../w9/helpers";

/**
 * A user for a test. People who work details (not vendors) get an approved W-9 row, so the W-9 sign-up lock (owner
 * decision 2026-11-27) does not get in the way; tests about W-9s pass `{ w9: false }`.
 */
export async function makeUser(db: Db, role: Role, email: string, extra: Partial<typeof users.$inferInsert> = {}, opts: { w9?: boolean } = {}) {
  const [row] = await db.insert(users).values({ name: email.split("@")[0], email, role, ...extra }).returning();
  if (role !== "vendor" && opts.w9 !== false) await giveApprovedW9(db, row.id);
  const actor: Actor = { userId: row.id, role, rankId: null, vendorId: null };
  return { row, actor };
}
