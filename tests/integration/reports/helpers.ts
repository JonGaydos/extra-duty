import { eq } from "drizzle-orm";
import type { Db } from "@/db/client";
import { assignments, invoiceEvents, invoices, jobs } from "@/db/schema";
import type { Actor } from "@/domain/actor";
import { agencyInstant } from "@/domain/time/agency-time";
import { setupFixture } from "../assignments/helpers";

export const NOW = new Date("2027-01-20T18:00:00Z");
export const at = (y: number, m: number, d: number, h = 12, min = 0) => agencyInstant(y, m, d, h, min);

type InvoiceStatus = (typeof invoices.$inferInsert)["status"];

export type FixtureInvoice = {
  person: Actor;
  vendorId?: string;
  start: Date;
  minutes: number;
  status: InvoiceStatus;
  deputyPaidAt?: Date;
  vendorPaidAt?: Date;
  /** A coordinator closed it as paid at this time (no deputyPaidAt). */
  closedPaidAt?: Date;
};

export async function buildFixture(db: Db, prefix: string) {
  const fx = await setupFixture(db, prefix);
  const deputy = await fx.person();
  const deputy2 = await fx.person();

  async function mkInvoice(o: FixtureInvoice) {
    const { job, positionId } = await fx.mkJob({ vendor: o.vendorId });
    await db
      .update(jobs)
      .set({ startAt: o.start, endAt: new Date(o.start.getTime() + o.minutes * 60_000) })
      .where(eq(jobs.id, job.id));
    const [a] = await db
      .insert(assignments)
      .values({ jobId: job.id, jobPositionId: positionId, userId: o.person.userId, status: o.status === "paid" ? "paid" : "billed" })
      .returning();
    const [inv] = await db
      .insert(invoices)
      .values({
        assignmentId: a.id,
        vendorId: o.vendorId ?? fx.vendorId,
        payeeUserId: o.person.userId,
        minutes: o.minutes,
        rateCents: 7000,
        totalCents: Math.round((o.minutes * 7000) / 60),
        status: o.status,
        sentAt: o.status === "pending_review" ? null : new Date(o.start.getTime() + 86_400_000),
        deputyPaidAt: o.deputyPaidAt ?? null,
        vendorPaidAt: o.vendorPaidAt ?? null,
        closedReason: o.closedPaidAt ? "Vendor never logs in" : null,
      })
      .returning();
    if (o.closedPaidAt) {
      await db.insert(invoiceEvents).values({ invoiceId: inv.id, event: "closed_paid", note: "Vendor never logs in", at: o.closedPaidAt });
    }
    return inv;
  }

  // Hand-computed totals (cents at 7000/hr): minutes * 7000 / 60.
  const A = await mkInvoice({ person: deputy, start: at(2026, 12, 28, 17), minutes: 240, status: "paid", deputyPaidAt: at(2027, 1, 5), vendorPaidAt: at(2026, 12, 30) }); // 28000
  const B = await mkInvoice({ person: deputy, start: at(2027, 1, 10, 17), minutes: 360, status: "sent" }); // 42000
  const C = await mkInvoice({ person: deputy, start: at(2027, 1, 12, 17), minutes: 120, status: "paid", deputyPaidAt: at(2027, 1, 15), vendorPaidAt: at(2027, 1, 14) }); // 14000
  const D = await mkInvoice({ person: deputy, vendorId: fx.otherVendorId, start: at(2026, 3, 3, 17), minutes: 300, status: "paid", deputyPaidAt: at(2026, 3, 10), vendorPaidAt: at(2026, 3, 9) }); // 35000
  const E = await mkInvoice({ person: deputy, start: at(2026, 6, 5, 17), minutes: 60, status: "returned" }); // 7000, never counted
  const F = await mkInvoice({ person: deputy, start: at(2026, 7, 5, 17), minutes: 120, status: "written_off" }); // 14000, never counted
  const G = await mkInvoice({ person: deputy, start: at(2026, 2, 5, 17), minutes: 180, status: "paid", closedPaidAt: at(2026, 2, 20) }); // 21000
  const H = await mkInvoice({ person: deputy, start: at(2027, 1, 14, 17), minutes: 60, status: "pending_review" }); // 7000
  // Another deputy: a detail that starts 11:30 PM Central on Nov 30, 2026 (already December in UTC).
  const I = await mkInvoice({ person: deputy2, start: at(2026, 11, 30, 23, 30), minutes: 120, status: "sent" }); // 14000
  const J = await mkInvoice({ person: deputy2, vendorId: fx.otherVendorId, start: at(2026, 12, 2, 17), minutes: 60, status: "paid", deputyPaidAt: at(2026, 12, 9), vendorPaidAt: at(2026, 12, 8) }); // 7000

  return { ...fx, deputy, deputy2, mkInvoice, inv: { A, B, C, D, E, F, G, H, I, J } };
}
