import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import type { Tx } from "@/db/client";
import { accessReviewItems, accessReviews, users } from "@/db/schema";
import type { Actor } from "../actor";
import { recordAudit } from "../audit/audit";
import { assertCan } from "../auth/policy";
import { NotFoundError, ValidationError } from "../errors";
import { getSettings } from "../settings/settings";
import { agencyDateParts } from "../time/agency-time";
import { deactivateUser } from "./users";

export const ACCESS_REVIEW_DUE_DAYS = 30;
/** The departure reason when the access review turns an account off. */
export const ACCESS_REVIEW_REASON = "Access review";
const DAY_MS = 86_400_000;

type Review = typeof accessReviews.$inferSelect;
type Item = typeof accessReviewItems.$inferSelect;
export type ReviewDecision = "keep" | "change" | "deactivate";

export async function findOpenReview(tx: Tx): Promise<Review | null> {
  const [r] = await tx.select().from(accessReviews).where(isNull(accessReviews.completedAt)).limit(1);
  return r ?? null;
}

/**
 * True on `accessReviewMonthDay` (agency time) when the newest review began at
 * least `accessReviewEveryMonths` months ago (or there is none).
 */
export async function accessReviewDue(tx: Tx, now: Date): Promise<boolean> {
  const s = await getSettings(tx);
  const p = agencyDateParts(now);
  const [mm, dd] = s.accessReviewMonthDay.split("-").map(Number);
  if (p.month !== mm || p.day !== dd) return false;
  const rows = await tx.select({ startedAt: accessReviews.startedAt }).from(accessReviews);
  if (!rows.length) return true;
  const monthIndex = (d: Date) => {
    const x = agencyDateParts(d);
    return x.year * 12 + x.month;
  };
  const latest = Math.max(...rows.map((r) => monthIndex(r.startedAt)));
  return monthIndex(now) - latest >= s.accessReviewEveryMonths;
}

/** Worker entry: starts a review when one is due and none is open. */
export async function accessReviewTick(tx: Tx, now: Date): Promise<Review | null> {
  if (!(await accessReviewDue(tx, now))) return null;
  return startAccessReview(tx, now);
}

/**
 * Creates a review with one item per active account (vendor logins included). Null if one is already open.
 * The worker starts it as "system"; a coordinator or admin may start one early from Management.
 */
export async function startAccessReview(tx: Tx, now: Date, actor: Actor | "system" = "system"): Promise<Review | null> {
  if (actor !== "system") assertCan(actor, "user.manage");
  if (await findOpenReview(tx)) return null;
  const [review] = await tx
    .insert(accessReviews)
    .values({ startedAt: now, dueAt: new Date(now.getTime() + ACCESS_REVIEW_DUE_DAYS * DAY_MS) })
    .returning();
  const active = await tx.select({ id: users.id }).from(users).where(eq(users.active, true));
  if (active.length) {
    await tx.insert(accessReviewItems).values(active.map((u) => ({ reviewId: review.id, userId: u.id })));
  }
  await recordAudit(tx, {
    actor,
    action: "access_review.start",
    entityType: "access_review",
    entityId: review.id,
    after: { dueAt: review.dueAt, items: active.length },
  });
  return review;
}

export async function decideAccessReviewItem(
  actor: Actor,
  tx: Tx,
  itemId: string,
  input: { decision: ReviewDecision; note?: string; lastDay?: string; reason?: string },
  now: Date = new Date(),
): Promise<Item> {
  assertCan(actor, "user.manage");
  if (!["keep", "change", "deactivate"].includes(input.decision)) throw new ValidationError("Decision is not valid.");
  const [before] = await tx.select().from(accessReviewItems).where(eq(accessReviewItems.id, itemId)).for("update");
  if (!before) throw new NotFoundError("Review item not found.");
  if (before.decision) throw new ValidationError("This item has already been decided.");
  const [review] = await tx.select().from(accessReviews).where(eq(accessReviews.id, before.reviewId));
  if (review.completedAt) throw new ValidationError("This review is complete.");

  // The same departure flow as turning someone off from their page: a last day is required, the reason defaults.
  if (input.decision === "deactivate") {
    await deactivateUser(actor, tx, before.userId, { reason: input.reason?.trim() || ACCESS_REVIEW_REASON, lastDay: input.lastDay ?? "" }, now);
  }
  const [after] = await tx
    .update(accessReviewItems)
    .set({ decision: input.decision, decidedBy: actor.userId, decidedAt: now, note: input.note ?? null })
    .where(eq(accessReviewItems.id, itemId))
    .returning();
  await recordAudit(tx, {
    actor,
    action: "access_review.decide",
    entityType: "access_review_item",
    entityId: itemId,
    before,
    after,
  });

  const [open] = await tx
    .select({ id: accessReviewItems.id })
    .from(accessReviewItems)
    .where(and(eq(accessReviewItems.reviewId, review.id), isNull(accessReviewItems.decision)))
    .limit(1);
  if (!open) {
    await tx.update(accessReviews).set({ completedAt: now }).where(eq(accessReviews.id, review.id));
    await recordAudit(tx, {
      actor,
      action: "access_review.complete",
      entityType: "access_review",
      entityId: review.id,
      before: { completedAt: null },
      after: { completedAt: now },
    });
  }
  return after;
}

/**
 * Daily reminder source (delivery arrives with notifications): the active
 * coordinators and admins to remind while a review has undecided items.
 */
export async function accessReviewReminderRecipients(
  tx: Tx,
): Promise<{ reviewId: string; pendingItems: number; recipients: { id: string; email: string; name: string }[] } | null> {
  const review = await findOpenReview(tx);
  if (!review) return null;
  const pending = await tx
    .select({ id: accessReviewItems.id })
    .from(accessReviewItems)
    .where(and(eq(accessReviewItems.reviewId, review.id), isNull(accessReviewItems.decision)));
  if (!pending.length) return null;
  const recipients = await tx
    .select({ id: users.id, email: users.email, name: users.name })
    .from(users)
    .where(and(eq(users.active, true), inArray(users.role, ["coordinator", "admin"])))
    .orderBy(asc(users.name));
  return { reviewId: review.id, pendingItems: pending.length, recipients };
}

export type AccessReviewReport = {
  review: Review;
  items: (Item & { userName: string; userEmail: string; userRole: string })[];
  counts: { keep: number; change: number; deactivate: number; pending: number };
};

export async function accessReviewReport(actor: Actor, tx: Tx, reviewId: string): Promise<AccessReviewReport> {
  assertCan(actor, "user.manage");
  const [review] = await tx.select().from(accessReviews).where(eq(accessReviews.id, reviewId));
  if (!review) throw new NotFoundError("Access review not found.");
  const rows = await tx
    .select({ item: accessReviewItems, name: users.name, email: users.email, role: users.role })
    .from(accessReviewItems)
    .innerJoin(users, eq(users.id, accessReviewItems.userId))
    .where(eq(accessReviewItems.reviewId, reviewId))
    .orderBy(asc(users.name));
  const items = rows.map((r) => ({ ...r.item, userName: r.name, userEmail: r.email, userRole: r.role }));
  const counts = { keep: 0, change: 0, deactivate: 0, pending: 0 };
  for (const i of items) counts[i.decision ?? "pending"]++;
  return { review, items, counts };
}
