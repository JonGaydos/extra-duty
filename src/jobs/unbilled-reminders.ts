import { and, asc, eq, gte, inArray, isNull, lte, or } from "drizzle-orm";
import { withTx } from "@/db/client";
import { assignments, invoices, jobs, users } from "@/db/schema";
import { getSettings } from "@/domain/settings/settings";
import { loadSentInvoices, loadUnbilled, reminderDue, unbilledOverdue } from "@/domain/billing/lock";
import { emit } from "@/domain/notifications/notify";
import { isJobLocked } from "@/domain/vendor-portal/holds";
import { formatInvoiceNumber } from "@/domain/invoices/invoices";
import { byText } from "@/lib/sort";

/** One failing row is logged and skipped so it cannot block the rest of the tick. */
async function guarded(what: string, fn: () => Promise<number>): Promise<number> {
  try {
    return await fn();
  } catch (err) {
    console.error(`Failed ${what}:`, err);
    return 0;
  }
}

/** Only jobs that ended within this window are alerted, so a first run never floods people with old details. */
const READY_WINDOW_MS = 7 * 86_400_000;

/**
 * Worker tick (every minute). Alerts each signed_up assignment once, when its job's end has passed, with
 * "Bill Detail #N". Canceled, declined and payment-locked jobs are skipped (a locked job is alerted after its
 * hold lifts). The marker is set in the same transaction as the alert, and only if nobody set it first.
 */
export async function billingReadyTick(now: Date): Promise<number> {
  const due = await withTx((tx) =>
    tx
      .select({ id: assignments.id })
      .from(assignments)
      .innerJoin(jobs, eq(jobs.id, assignments.jobId))
      .where(
        and(
          // Worked details that are still open, and late-cancel pay on canceled ones (billable from the end time).
          or(
            and(eq(assignments.status, "signed_up"), inArray(jobs.state, ["requested", "scheduled", "active"])),
            and(eq(assignments.status, "late_canceled"), eq(jobs.state, "canceled")),
          ),
          isNull(assignments.billReadyAlertedAt),
          lte(jobs.endAt, now),
          gte(jobs.endAt, new Date(now.getTime() - READY_WINDOW_MS)),
        ),
      )
      .orderBy(asc(assignments.id)),
  );
  let sent = 0;
  // Sequential: one transaction per assignment, so one failure is skipped without holding many connections.
  for (const { id } of due) {
    sent += await guarded(`billing.ready for assignment ${id}`, () => withTx(async (tx) => {
      const [row] = await tx
        .select({ a: assignments, job: jobs })
        .from(assignments)
        .innerJoin(jobs, eq(jobs.id, assignments.jobId))
        .where(eq(assignments.id, id))
        .for("update", { of: assignments });
      const lateCancel = row?.a.status === "late_canceled";
      if (!row || (row.a.status !== "signed_up" && !lateCancel) || row.a.billReadyAlertedAt) return 0;
      if (await isJobLocked(tx, row.job.id)) return 0;
      await tx.update(assignments).set({ billReadyAlertedAt: now }).where(eq(assignments.id, id));
      await emit(
        tx,
        {
          recipients: [row.a.userId],
          type: "billing.ready",
          title: lateCancel ? `Bill late cancellation pay for Detail #${row.job.number}` : `Bill Detail #${row.job.number}`,
          body: lateCancel ? `${row.job.title} was canceled late and its end time has passed. Bill your late cancellation pay.` : `${row.job.title} has ended. Enter your hours and bill it.`,
          link: `/jobs/${row.job.id}`,
        },
        now,
      );
      return 1;
    }));
  }
  return sent;
}

/**
 * Daily tick (8:10 AM agency time). For each person with details past the grace period or invoices waiting
 * on their payment confirmation, sends one reminder when the chosen frequency says it is due, and stores
 * when it was sent.
 */
export async function unbilledRemindersTick(now: Date): Promise<number> {
  const candidates = await withTx(async (tx) => {
    const a = await tx
      .selectDistinct({ id: assignments.userId })
      .from(assignments)
      .where(inArray(assignments.status, ["signed_up", "late_canceled"]));
    const i = await tx
      .selectDistinct({ id: invoices.payeeUserId })
      .from(invoices)
      .where(and(eq(invoices.status, "sent"), eq(invoices.responsibleParty, "deputy")));
    return [...new Set([...a, ...i].map((r) => r.id))].sort(byText);
  });
  let sent = 0;
  // Sequential: one transaction per person, so one failure is skipped without holding many connections.
  for (const userId of candidates) {
    sent += await guarded(`unbilled reminder for user ${userId}`, () => withTx(async (tx) => {
      const [user] = await tx.select().from(users).where(eq(users.id, userId)).for("update");
      if (!user?.active) return 0;
      const s = await getSettings(tx);
      if (!reminderDue(user.unbilledReminderSentAt, s.unbilledReminderFrequency, now)) return 0;
      const unbilled = (await loadUnbilled(tx, userId, now)).filter((u) => unbilledOverdue(u.endAt, now, s));
      // Only invoices that would count toward the acknowledgment lock need action: waiting on the person, no open issue, not marked paid.
      const waiting = (await loadSentInvoices(tx, userId)).filter(
        (i) => i.responsibleParty === "deputy" && !i.hasOpenIssue && !i.deputyPaidAt,
      );
      if (unbilled.length === 0 && waiting.length === 0) return 0;
      const lines = [
        ...unbilled.map((u) => `Bill Detail #${u.jobNumber}, ${u.title}: /jobs/${u.jobId}`),
        ...waiting.map((i) => `Confirm payment on invoice ${formatInvoiceNumber(s.invoiceNumberPrefix, i.number)}: /jobs/${i.jobId}`),
      ];
      await tx.update(users).set({ unbilledReminderSentAt: now }).where(eq(users.id, userId));
      await emit(
        tx,
        {
          recipients: [userId],
          type: "billing.unbilled_reminder",
          title: `${unbilled.length + waiting.length} ${unbilled.length + waiting.length === 1 ? "item needs" : "items need"} your attention`,
          body: lines.join("\n"),
          link: unbilled.length > 0 ? `/jobs/${unbilled[0].jobId}` : `/jobs/${waiting[0].jobId}`,
          jobIds: [...new Set([...unbilled.map((u) => u.jobId), ...waiting.map((i) => i.jobId)])],
        },
        now,
      );
      return 1;
    }));
  }
  return sent;
}
