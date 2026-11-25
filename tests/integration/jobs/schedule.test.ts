import { describe, expect, test } from "vitest";
import { useTestDb } from "../../setup/test-db";
import { useEmailQueue } from "../../setup/email-queue";
import { EMAIL_QUEUE, getBoss } from "@/jobs/boss";
import { registerSchedule, tickQueue, type ScheduledTick } from "@/jobs/schedule";

describe("registerSchedule", () => {
  const get = useTestDb();
  useEmailQueue(get);
  const tick = (name: string): ScheduledTick => ({ name, cron: "10 2 * * *", tz: "America/Chicago", run: async () => {} });

  test("schedules each tick in its timezone and drops schedules of removed ticks", async () => {
    const boss = await getBoss();
    await registerSchedule(boss, [tick("old"), tick("keep")]);
    expect((await boss.getSchedules()).map((s) => s.name).sort()).toEqual([tickQueue(tick("keep")), tickQueue(tick("old"))].sort());
    await registerSchedule(boss, [tick("keep")]);
    const left = await boss.getSchedules();
    expect(left.map((s) => s.name)).toEqual(["tick.keep"]);
    expect(left[0]).toMatchObject({ cron: "10 2 * * *", timezone: "America/Chicago" });
  });

  test("the email queue carries the retry and retention options", async () => {
    const q = await (await getBoss()).getQueue(EMAIL_QUEUE);
    expect(q).toMatchObject({ retryLimit: 6, retryDelay: 30, retryBackoff: true, deleteAfterSeconds: 3600 });
  });
});
