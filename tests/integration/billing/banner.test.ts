import { beforeAll, describe, expect, test } from "vitest";
import { useTestDb } from "../../setup/test-db";
import { useEmailQueue } from "../../setup/email-queue";
import { setupFixture } from "../assignments/helpers";
import { eq } from "drizzle-orm";
import { assignments, invoices } from "@/db/schema";
import type { Actor } from "@/domain/actor";
import { loadBillingBanner } from "@/domain/billing/banner";
import { agencyInstant } from "@/domain/time/agency-time";

/** Owner request 2026-11-27: Home's billing banner, for everyone who bills, staff included. */
describe("the billing action banner", () => {
  const get = useTestDb();
  useEmailQueue(get);
  let f: Awaited<ReturnType<typeof setupFixture>>;

  beforeAll(async () => {
    f = await setupFixture(get().db, "banner");
  });

  // mkJob's first detail ends at 11 PM on Mar 1, 2035 (agency time).
  const worked = async (who: Actor) => {
    const { job, positionId } = await f.mkJob();
    const [a] = await get().db.insert(assignments).values({ jobId: job.id, jobPositionId: positionId, userId: who.userId, status: "signed_up" }).returning();
    return { job, a };
  };

  test("nothing to do: no banner", async () => {
    const me = await f.person();
    expect(await f.run((tx) => loadBillingBanner(me, tx, agencyInstant(2035, 3, 2, 9, 0)))).toBeNull();
  });

  test("a worked detail not billed shows, clears after billing, and says plainly when the lock is on", async () => {
    const me = await f.person();
    const { job, a } = await worked(me);
    const soon = new Date(job.endAt.getTime() + 3_600_000);
    const b = await f.run((tx) => loadBillingBanner(me, tx, soon));
    expect(b).toMatchObject({ tone: "warning", title: "You have 1 worked detail to bill.", detail: "Billing them keeps your sign-ups open.", action: { href: "/billing?tab=bill" } });

    const late = new Date(job.endAt.getTime() + 10 * 86_400_000);
    const locked = await f.run((tx) => loadBillingBanner(me, tx, late));
    expect(locked).toMatchObject({ tone: "danger", detail: "Sign-ups are locked until you bill these." });

    // Billing moves the sign-up to billed (the invoice and its email are covered by the billing suites).
    await get().db.update(assignments).set({ status: "billed" }).where(eq(assignments.id, a.id));
    expect(await f.run((tx) => loadBillingBanner(me, tx, late))).toBeNull();
  });

  test("a payment the vendor reported, waiting for the person's confirmation, needs their attention", async () => {
    const me = await f.person();
    const { job, a } = await worked(me);
    await get().db.update(assignments).set({ status: "billed" }).where(eq(assignments.id, a.id));
    const sent = new Date(job.endAt.getTime() + 86_400_000);
    await get().db.insert(invoices).values({
      assignmentId: a.id,
      vendorId: f.vendorId,
      payeeUserId: me.userId,
      minutes: 360,
      rateCents: 7000,
      totalCents: 42000,
      status: "sent",
      sentAt: sent,
      vendorPaidAt: sent,
      responsibleParty: "deputy",
      responsibleSince: sent,
    });
    const b = await f.run((tx) => loadBillingBanner(me, tx, new Date(sent.getTime() + 3_600_000)));
    expect(b).toMatchObject({ title: "1 invoice needs your attention.", action: { href: "/billing?tab=waiting&needs=1", label: "Go to billing" } });
  });

  test("coordinators who work details get it too", async () => {
    const { job } = await worked(f.coord);
    const b = await f.run((tx) => loadBillingBanner(f.coord, tx, new Date(job.endAt.getTime() + 3_600_000)));
    expect(b?.title).toBe("You have 1 worked detail to bill.");
  });
});
