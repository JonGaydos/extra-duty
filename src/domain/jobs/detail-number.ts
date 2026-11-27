import { eq } from "drizzle-orm";
import type { Tx } from "@/db/client";
import { jobs } from "@/db/schema";
import type { Actor } from "../actor";
import { ForbiddenError, NotFoundError } from "../errors";
import { getJob } from "./jobs";

/**
 * Every detail has one sequential number, its name in the app ("#9", or "Detail #9" where there is room) and in its
 * address (/jobs/9). Numbers can be guessed, so a number resolves only for someone who may see that detail; anyone
 * else gets the same answer as for a number that does not exist.
 */

export { detailName, detailRef, detailTitle, parseDetailNumber } from "./detail-name";

/** A detail id that the actor may see, or null when the detail is not theirs to see (never says which). */
async function visible(actor: Actor, tx: Tx, id: string): Promise<boolean> {
  try {
    await getJob(actor, tx, id);
    return true;
  } catch (e) {
    if (e instanceof NotFoundError || e instanceof ForbiddenError) return false;
    throw e;
  }
}

/** The id of detail #n, when the actor may see it. */
export async function visibleJobIdByNumber(actor: Actor, tx: Tx, n: number): Promise<string | null> {
  const [row] = await tx.select({ id: jobs.id }).from(jobs).where(eq(jobs.number, n));
  return row && (await visible(actor, tx, row.id)) ? row.id : null;
}

/** The number of the detail with this id, when the actor may see it. */
export async function visibleJobNumber(actor: Actor, tx: Tx, id: string): Promise<number | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const [row] = await tx.select({ number: jobs.number }).from(jobs).where(eq(jobs.id, id));
  return row && (await visible(actor, tx, id)) ? row.number : null;
}
