import { and, eq, isNull } from "drizzle-orm";
import type { Tx } from "@/db/client";
import { vendorRestrictions } from "@/db/schema";

/** True while the person holds an unlifted coordinator restriction for the vendor. */
export async function isRestricted(tx: Tx, userId: string, vendorId: string): Promise<boolean> {
  const rows = await tx
    .select({ id: vendorRestrictions.id })
    .from(vendorRestrictions)
    .where(and(eq(vendorRestrictions.userId, userId), eq(vendorRestrictions.vendorId, vendorId), isNull(vendorRestrictions.liftedAt)))
    .limit(1);
  return rows.length > 0;
}
