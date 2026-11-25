import type { PgBoss } from "pg-boss";
import { liveDb, runInMode, trainingConfigured, withTx, type DataMode } from "@/db/client";
import { pruneThrottle } from "@/domain/auth/sign-in-policy";
import { confirmPendingShortTick } from "@/domain/assignments/signup";
import { emit } from "@/domain/notifications/notify";
import { invoiceBatchesDueTick } from "@/domain/invoices/batch";
import { accessReviewReminderRecipients, accessReviewTick } from "@/domain/users/access-review";
import { inactivityLockTick, liftExpiredSuspensions } from "@/domain/users/suspension";
import { contractExpiryTick } from "@/domain/vendors/vendors";
import { AGENCY_TZ } from "@/domain/time/agency-time";
import { opsPlanRemindersTick } from "./ops-plan-reminders";
import { billingReadyTick, unbilledRemindersTick } from "./unbilled-reminders";
import { responseDeadlinesTick } from "./vendor-reminders";
import { backupOfferTick, watchReleaseTick } from "./backup-window";
import { calendarFeedsTick } from "./calendar-feeds";
import { trainingResetTick } from "./training-reset";

export type ScheduledTick = {
  /** Unique; also the queue name is `tick.<name>`. */
  name: string;
  /** Cron expression, evaluated in `tz`. */
  cron: string;
  tz: string;
  run: (now: Date) => Promise<unknown>;
  /** The databases it runs against: both by default (training only where it is set up). */
  modes?: readonly DataMode[];
};

/** The modes a tick runs in on this deployment, live first. */
export function tickModes(t: Pick<ScheduledTick, "modes">): DataMode[] {
  return (t.modes ?? ["live", "training"]).filter((m) => m === "live" || trainingConfigured());
}

const EVERY_MINUTE = "* * * * *";
/** 2:00 AM every day, agency time. */
const DAILY_2_00 = "0 2 * * *";
/** 2:10 AM every day, agency time. */
const DAILY_2_10 = "10 2 * * *";
/** 3:20 AM every day, agency time. */
const DAILY_3_20 = "20 3 * * *";
/** 7:10 AM every day, agency time. */
const DAILY_7_10 = "10 7 * * *";
/** 7:20 AM every day, agency time. */
const DAILY_7_20 = "20 7 * * *";
/** 7:40 AM every day, agency time. */
const DAILY_7_40 = "40 7 * * *";
/** 8:10 AM every day, agency time. */
const DAILY_8_10 = "10 8 * * *";

async function accessReviewDaily(now: Date): Promise<void> {
  await withTx(async (tx) => {
    await accessReviewTick(tx, now);
    const due = await accessReviewReminderRecipients(tx);
    if (!due) return;
    await emit(tx, {
      recipients: due.recipients.map((r) => r.id),
      type: "access_review.reminder",
      title: "Access review needs decisions",
      body: `${due.pendingItems} account${due.pendingItems === 1 ? "" : "s"} still need a keep, change or deactivate decision.`,
      link: "/access-review",
    });
  });
}

/** Every recurring job. Later tasks add theirs here. */
export const SCHEDULE: readonly ScheduledTick[] = [
  { name: "confirm-pending-short", cron: EVERY_MINUTE, tz: AGENCY_TZ, run: (now) => confirmPendingShortTick(now) },
  { name: "backup-offer", cron: EVERY_MINUTE, tz: AGENCY_TZ, run: (now) => backupOfferTick(now) },
  { name: "watch-release", cron: EVERY_MINUTE, tz: AGENCY_TZ, run: (now) => watchReleaseTick(now) },
  { name: "billing-ready", cron: EVERY_MINUTE, tz: AGENCY_TZ, run: (now) => billingReadyTick(now) },
  { name: "response-deadlines", cron: DAILY_7_10, tz: AGENCY_TZ, run: (now) => responseDeadlinesTick(now) },
  { name: "invoice-batches-due", cron: DAILY_7_20, tz: AGENCY_TZ, run: (now) => invoiceBatchesDueTick(now) },
  { name: "ops-plan-reminders", cron: DAILY_7_40, tz: AGENCY_TZ, run: (now) => opsPlanRemindersTick(now) },
  { name: "unbilled-reminders", cron: DAILY_8_10, tz: AGENCY_TZ, run: (now) => unbilledRemindersTick(now) },
  { name: "lift-expired-suspensions", cron: DAILY_2_10, tz: AGENCY_TZ, run: (now) => withTx((tx) => liftExpiredSuspensions(tx, now)) },
  { name: "inactivity-lock", cron: DAILY_2_10, tz: AGENCY_TZ, run: (now) => withTx((tx) => inactivityLockTick(tx, now)) },
  { name: "contract-expiry", cron: DAILY_2_10, tz: AGENCY_TZ, run: (now) => withTx((tx) => contractExpiryTick(tx, now)) },
  { name: "calendar-feeds", cron: DAILY_3_20, tz: AGENCY_TZ, run: (now) => calendarFeedsTick(now) },
  { name: "access-review", cron: DAILY_2_10, tz: AGENCY_TZ, run: accessReviewDaily },
  // Sign-in attempts are kept only in the live database.
  { name: "auth-throttle-prune", cron: DAILY_2_10, tz: AGENCY_TZ, run: (now) => pruneThrottle(liveDb, now), modes: ["live"] },
  { name: "training-reset", cron: DAILY_2_00, tz: AGENCY_TZ, run: trainingResetTick, modes: ["training"] },
];

export const tickQueue = (t: Pick<ScheduledTick, "name">) => `tick.${t.name}`;

/**
 * Runs one tick against each of its databases in turn. A failure is logged and swallowed, so it never fails the job,
 * stops the other database's run or the other ticks.
 */
export async function runTick(t: ScheduledTick, now: Date = new Date()): Promise<void> {
  for (const mode of tickModes(t)) {
    try {
      await runInMode(mode, () => t.run(now));
    } catch (err) {
      console.error(`Scheduled job ${t.name} failed${mode === "training" ? " (training)" : ""}:`, err);
    }
  }
}

/** Creates one queue per tick, schedules it and registers its handler. Schedules of removed ticks are dropped. */
export async function registerSchedule(boss: PgBoss, ticks: readonly ScheduledTick[] = SCHEDULE): Promise<void> {
  const wanted = new Set(ticks.map(tickQueue));
  for (const s of await boss.getSchedules()) {
    if (s.name.startsWith("tick.") && !wanted.has(s.name)) await boss.unschedule(s.name, s.key);
  }
  for (const t of ticks) {
    const queue = tickQueue(t);
    // The release step creates every known tick queue; only one it does not know (a test's) is created here.
    if (!(await boss.getQueue(queue))) await boss.createQueue(queue);
    await boss.schedule(queue, t.cron, null, { tz: t.tz });
    await boss.work(queue, async () => {
      await runTick(t);
    });
  }
}
