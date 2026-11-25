import { users } from "@/db/schema";
import type { Db } from "@/db/client";
import type { Actor, Role } from "@/domain/actor";

export async function makeUser(db: Db, role: Role, email: string, extra: Partial<typeof users.$inferInsert> = {}) {
  const [row] = await db.insert(users).values({ name: email.split("@")[0], email, role, ...extra }).returning();
  const actor: Actor = { userId: row.id, role, rankId: null, vendorId: null };
  return { row, actor };
}
