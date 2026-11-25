import { beforeAll, describe, expect, test } from "vitest";
import { eq } from "drizzle-orm";
import { useTestDb } from "../../setup/test-db";
import { makeUser } from "./helpers";
import { accessReviewItems, accessReviews, users } from "@/db/schema";
import { seed } from "@/db/seed";
import type { Actor } from "@/domain/actor";
import { ForbiddenError } from "@/domain/errors";
import { agencyInstant } from "@/domain/time/agency-time";
import {
  accessReviewDue,
  accessReviewReminderRecipients,
  accessReviewReport,
  accessReviewTick,
  decideAccessReviewItem,
  startAccessReview,
} from "@/domain/users/access-review";

describe("access review", () => {
  const get = useTestDb();
  let coordinator: Actor;
  let personnel: Actor;
  let vendorId: string;
  let inactiveId: string;
  const jan15 = agencyInstant(2027, 1, 15, 6, 0);

  beforeAll(async () => {
    const { db } = get();
    await seed(db);
    coordinator = (await makeUser(db, "coordinator", "coord@example.test")).actor;
    personnel = (await makeUser(db, "personnel", "pers@example.test")).actor;
    vendorId = (await makeUser(db, "vendor", "vend@example.test")).row.id;
    inactiveId = (await makeUser(db, "personnel", "off@example.test", { active: false })).row.id;
  });

  test("due only on the configured month and day, and not again within 12 months", async () => {
    const { db } = get();
    expect(await db.transaction((tx) => accessReviewDue(tx, agencyInstant(2027, 1, 14, 6, 0)))).toBe(false);
    expect(await db.transaction((tx) => accessReviewDue(tx, jan15))).toBe(true);
    expect(await db.transaction((tx) => accessReviewTick(tx, agencyInstant(2027, 1, 14, 6, 0)))).toBeNull();
  });

  test("a review on Jan 15 has one item per active account, vendor included", async () => {
    const { db } = get();
    const review = await db.transaction((tx) => accessReviewTick(tx, jan15));
    expect(review).not.toBeNull();
    const items = await db.select().from(accessReviewItems).where(eq(accessReviewItems.reviewId, review!.id));
    const ids = items.map((i) => i.userId);
    expect(ids).toContain(vendorId);
    expect(ids).not.toContain(inactiveId);
    expect(items).toHaveLength(3);
  });

  test("a second review is not created while one is open", async () => {
    const { db } = get();
    expect(await db.transaction((tx) => startAccessReview(tx, jan15))).toBeNull();
    expect(await db.select().from(accessReviews)).toHaveLength(1);
  });

  test("reminders go to coordinators and admins while items are undecided", async () => {
    const { db } = get();
    const r = await db.transaction((tx) => accessReviewReminderRecipients(tx));
    expect(r?.pendingItems).toBe(3);
    expect(r?.recipients.map((x) => x.id)).toEqual([coordinator.userId]);
  });

  test("personnel cannot decide; deactivate deactivates; review completes when all decided", async () => {
    const { db } = get();
    const items = await db.select().from(accessReviewItems);
    const byUser = (id: string) => items.find((i) => i.userId === id)!;
    await expect(
      db.transaction((tx) => decideAccessReviewItem(personnel, tx, byUser(vendorId).id, { decision: "keep" })),
    ).rejects.toBeInstanceOf(ForbiddenError);

    await db.transaction((tx) => decideAccessReviewItem(coordinator, tx, byUser(vendorId).id, { decision: "deactivate", note: "left", lastDay: "2026-01-02" }));
    const [v] = await db.select().from(users).where(eq(users.id, vendorId));
    expect(v.active).toBe(false);

    await db.transaction((tx) => decideAccessReviewItem(coordinator, tx, byUser(personnel.userId).id, { decision: "keep" }));
    expect((await db.select().from(accessReviews))[0].completedAt).toBeNull();
    expect((await db.transaction((tx) => accessReviewReminderRecipients(tx)))?.pendingItems).toBe(1);

    await db.transaction((tx) => decideAccessReviewItem(coordinator, tx, byUser(coordinator.userId).id, { decision: "change" }));
    const [review] = await db.select().from(accessReviews);
    expect(review.completedAt).not.toBeNull();
    expect(await db.transaction((tx) => accessReviewReminderRecipients(tx))).toBeNull();

    const report = await db.transaction((tx) => accessReviewReport(coordinator, tx, review.id));
    expect(report.counts).toEqual({ keep: 1, change: 1, deactivate: 1, pending: 0 });
  });
});
