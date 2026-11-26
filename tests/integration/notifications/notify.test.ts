import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { eq, sql } from "drizzle-orm";

const push = vi.hoisted(() => ({ setVapidDetails: vi.fn(), sendNotification: vi.fn() }));
vi.mock("web-push", () => ({ ...push, default: push }));

import { useTestDb } from "../../setup/test-db";
import { useEmailQueue } from "../../setup/email-queue";
import { makeUser } from "../users/helpers";
import { notificationPrefs, notifications, pushSubscriptions, quietHours, users } from "@/db/schema";
import { ValidationError } from "@/domain/errors";
import { emit } from "@/domain/notifications/notify";
import { markRead, setPreference, setQuietHours, subscribePush } from "@/domain/notifications/prefs";
import { NOTIFY_EMAIL_QUEUE, NOTIFY_PUSH_QUEUE } from "@/jobs/boss";
import { setEmailSender } from "@/lib/email/sender";
import { createMemorySender } from "@/lib/email/types";
import { agencyInstant } from "@/domain/time/agency-time";
import { byText } from "@/lib/sort";

// Fake push sends are async to match web-push; they answer at once.

describe("notification core", () => {
  const get = useTestDb();
  const { drainNotifications: drain } = useEmailQueue(get);
  const mail = createMemorySender();
  let n = 0;
  const person = async (role: "personnel" | "coordinator" | "vendor" = "personnel", extra: Partial<typeof users.$inferInsert> = {}) =>
    makeUser(get().db, role, `n${++n}@example.test`, extra);
  const ev = (recipients: string[], extra: Record<string, unknown> = {}) => ({
    type: "job.changed" as const,
    recipients,
    title: "Detail changed",
    body: "The start time moved.",
    link: "/jobs/abc",
    ...extra,
  });
  const run = (e: ReturnType<typeof ev>) => get().db.transaction((tx) => emit(tx, e as never));
  const inbox = (userId: string) => get().db.select().from(notifications).where(eq(notifications.userId, userId));
  const jobs = async (queue: string) =>
    (await get().db.execute(sql`select state, start_after as "startAfter" from pgboss.job where name = ${queue}`)).rows as { state: string; startAfter: Date }[];
  const sub = (userId: string, endpoint = `https://push.example.test/${userId}`) =>
    get().db.insert(pushSubscriptions).values({ userId, endpoint, keys: { p256dh: "k", auth: "a" } });

  beforeAll(async () => {
    await get().db.execute(sql`select 1`);
  });
  beforeEach(async () => {
    mail.clear();
    setEmailSender(mail);
    push.sendNotification.mockReset();
    process.env.VAPID_PUBLIC_KEY = "pub";
    process.env.VAPID_PRIVATE_KEY = "priv";
    process.env.VAPID_SUBJECT = "mailto:ops@example.test";
    await drain();
    await get().db.execute(sql`delete from pgboss.job where name in (${NOTIFY_EMAIL_QUEUE}, ${NOTIFY_PUSH_QUEUE})`);
  });
  afterEach(() => vi.useRealTimers());

  test("a recipient with email off gets an inbox row and no email", async () => {
    const off = await person();
    const on = await person();
    await get().db.insert(notificationPrefs).values({ userId: off.row.id, type: "job.changed", email: false, push: false });
    await run(ev([off.row.id, on.row.id]));
    expect(await inbox(off.row.id)).toHaveLength(1);
    expect(await inbox(on.row.id)).toHaveLength(1);
    await drain();
    expect(mail.sent.map((m) => m.to)).toEqual([[on.row.email]]);
    expect(mail.sent[0].subject).toBe("Detail changed");
    expect(mail.sent[0].text).toContain("http://localhost:3000/jobs/abc");
  });

  test("push goes only to users with a subscription and push on", async () => {
    const a = await person();
    const b = await person();
    await sub(a.row.id);
    await sub(b.row.id);
    await get().db.insert(notificationPrefs).values({ userId: b.row.id, type: "job.changed", email: true, push: false });
    await run(ev([a.row.id, b.row.id]));
    await drain();
    expect(push.sendNotification).toHaveBeenCalledTimes(1);
    expect(push.sendNotification.mock.calls[0][0].endpoint).toBe(`https://push.example.test/${a.row.id}`);
  });

  const retryNow = () => get().db.execute(sql`update pgboss.job set start_after = now() where name = ${NOTIFY_PUSH_QUEUE} and state = 'retry'`);
  const pushJobStates = async () => (await jobs(NOTIFY_PUSH_QUEUE)).map((j) => j.state);

  test("a 410 or 404 deletes the subscription; a 503 keeps it and retries only that device", async () => {
    const a = await person();
    await sub(a.row.id, "https://push.example.test/gone");
    await sub(a.row.id, "https://push.example.test/missing");
    await sub(a.row.id, "https://push.example.test/flaky");
    await sub(a.row.id, "https://push.example.test/fine");
    let flakyUp = false;
    push.sendNotification.mockImplementation((s: { endpoint: string }) => {
      if (s.endpoint.endsWith("gone")) return Promise.reject(Object.assign(new Error("gone"), { statusCode: 410 }));
      if (s.endpoint.endsWith("missing")) return Promise.reject(Object.assign(new Error("missing"), { statusCode: 404 }));
      if (s.endpoint.endsWith("flaky") && !flakyUp) return Promise.reject(Object.assign(new Error("busy"), { statusCode: 503 }));
      return Promise.resolve();
    });
    await run(ev([a.row.id]));
    await drain();
    const left = await get().db.select().from(pushSubscriptions).where(eq(pushSubscriptions.userId, a.row.id));
    expect(left.map((s) => s.endpoint).sort(byText)).toEqual(["https://push.example.test/fine", "https://push.example.test/flaky"]);
    expect(await pushJobStates()).toEqual(["retry"]);
    expect(push.sendNotification).toHaveBeenCalledTimes(4);

    push.sendNotification.mockClear();
    flakyUp = true;
    await retryNow();
    await drain();
    expect(push.sendNotification.mock.calls.map((c) => c[0].endpoint)).toEqual(["https://push.example.test/flaky"]);
    expect(await pushJobStates()).toEqual(["completed"]);
  });

  test("when every device fails with a 5xx the job fails and is retried", async () => {
    const a = await person();
    await sub(a.row.id);
    push.sendNotification.mockRejectedValue(Object.assign(new Error("down"), { statusCode: 500 }));
    await run(ev([a.row.id]));
    await drain();
    expect(await pushJobStates()).toEqual(["retry"]);
  });

  test("types with no action default to inbox only; message.received defaults to push without email", async () => {
    const a = await person();
    await sub(a.row.id);
    await run(ev([a.row.id], { type: "spot.offer_ended" }));
    await drain();
    expect(await inbox(a.row.id)).toHaveLength(1);
    expect(mail.sent).toHaveLength(0);
    expect(await jobs(NOTIFY_EMAIL_QUEUE)).toHaveLength(0);
    expect(await jobs(NOTIFY_PUSH_QUEUE)).toHaveLength(0);

    await run(ev([a.row.id], { type: "message.received" }));
    await drain();
    expect(mail.sent).toHaveLength(0);
    expect(push.sendNotification).toHaveBeenCalledTimes(1);
    // An explicit choice overrides the default.
    await get().db.insert(notificationPrefs).values({ userId: a.row.id, type: "spot.offer_ended", email: true, push: false });
    await run(ev([a.row.id], { type: "spot.offer_ended" }));
    await drain();
    expect(mail.sent).toHaveLength(1);
  });

  test("markRead refuses a malformed id with a validation error", async () => {
    const a = await person();
    await expect(get().db.transaction((tx) => markRead(a.actor, tx, ["not-a-uuid"]))).rejects.toBeInstanceOf(ValidationError);
  });

  test("an alert email without any base URL warns once and still sends", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const saved = process.env.BETTER_AUTH_URL;
    delete process.env.BETTER_AUTH_URL;
    const a = await person();
    await run(ev([a.row.id]));
    await run(ev([a.row.id]));
    await drain();
    process.env.BETTER_AUTH_URL = saved;
    expect(mail.sent).toHaveLength(2);
    expect(mail.sent[0].text).not.toContain("Open in Extra Duty");
    expect(warn.mock.calls.filter((c) => String(c[0]).includes("APP_URL"))).toHaveLength(1);
    warn.mockRestore();
  });

  test("a mandatory alert ignores preferences and quiet hours; a normal one is held until quiet hours end", async () => {
    const a = await person();
    await sub(a.row.id);
    await get().db.insert(notificationPrefs).values({ userId: a.row.id, type: "job.changed", email: false, push: false });
    await get().db.insert(quietHours).values({ userId: a.row.id, enabled: true, startTime: "00:00", endTime: "23:59" });
    // Quiet all day except the last minute, so "now" is always inside it for this test.
    vi.useFakeTimers({ toFake: ["Date"], now: agencyInstant(2027, 11, 10, 12, 0) });
    await run(ev([a.row.id], { mandatory: true }));
    vi.useRealTimers();
    await drain();
    expect(push.sendNotification).toHaveBeenCalledTimes(1);
    expect(mail.sent).toHaveLength(1);

    await get().db.update(notificationPrefs).set({ push: true, email: true }).where(eq(notificationPrefs.userId, a.row.id));
    push.sendNotification.mockClear();
    vi.useFakeTimers({ toFake: ["Date"], now: agencyInstant(2027, 11, 10, 12, 0) });
    await run(ev([a.row.id]));
    vi.useRealTimers();
    await drain();
    expect(push.sendNotification).not.toHaveBeenCalled();
    const held = (await jobs(NOTIFY_PUSH_QUEUE)).filter((j) => j.state === "created");
    expect(held).toHaveLength(1);
    expect(new Date(held[0].startAfter)).toEqual(agencyInstant(2027, 11, 10, 23, 59));
    expect(mail.sent).toHaveLength(2); // email is not held
  });

  test("nothing is sent and no inbox row is kept if the transaction rolls back", async () => {
    const a = await person();
    await sub(a.row.id);
    await expect(
      get().db.transaction(async (tx) => {
        await emit(tx, ev([a.row.id]) as never);
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    await drain();
    expect(mail.sent).toHaveLength(0);
    expect(push.sendNotification).not.toHaveBeenCalled();
    expect(await inbox(a.row.id)).toHaveLength(0);
    expect(await jobs(NOTIFY_EMAIL_QUEUE)).toHaveLength(0);
    expect(await jobs(NOTIFY_PUSH_QUEUE)).toHaveLength(0);
  });

  test("recipients are deduplicated and inactive users are skipped", async () => {
    const a = await person();
    const gone = await person("personnel", { active: false });
    await run(ev([a.row.id, a.row.id, gone.row.id]));
    expect(await inbox(a.row.id)).toHaveLength(1);
    expect(await inbox(gone.row.id)).toHaveLength(0);
    await drain();
    expect(mail.sent).toHaveLength(1);
  });

  test("vendors get an inbox row and email but never push", async () => {
    const v = await person("vendor");
    await sub(v.row.id);
    await run(ev([v.row.id]));
    await drain();
    expect(await inbox(v.row.id)).toHaveLength(1);
    expect(mail.sent).toHaveLength(1);
    expect(push.sendNotification).not.toHaveBeenCalled();
  });

  test("missing VAPID keys skip push with one warning and no crash", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    delete process.env.VAPID_PRIVATE_KEY;
    const a = await person();
    await sub(a.row.id);
    await run(ev([a.row.id]));
    await run(ev([a.row.id]));
    await drain();
    expect(push.sendNotification).not.toHaveBeenCalled();
    expect(warn.mock.calls.filter((c) => String(c[0]).includes("VAPID"))).toHaveLength(1);
    warn.mockRestore();
  });

  test("preferences, quiet hours, subscriptions and read state act only on the actor's own rows", async () => {
    const a = await person();
    const b = await person();
    const { db } = get();
    await db.transaction((tx) => setPreference(a.actor, tx, "job.changed", { email: false, push: true }));
    await db.transaction((tx) => setPreference(a.actor, tx, "job.changed", { email: true, push: false }));
    const prefs = await db.select().from(notificationPrefs);
    expect(prefs.filter((p) => p.userId === a.row.id)).toEqual([expect.objectContaining({ type: "job.changed", email: true, push: false })]);
    expect(prefs.filter((p) => p.userId === b.row.id)).toHaveLength(0);
    await expect(db.transaction((tx) => setPreference(a.actor, tx, "nope.nothing", { email: true, push: true }))).rejects.toBeInstanceOf(ValidationError);

    await db.transaction((tx) => setQuietHours(a.actor, tx, { start: "22:00", end: "06:00" }));
    expect((await db.select().from(quietHours).where(eq(quietHours.userId, a.row.id)))[0]).toMatchObject({ enabled: true, startTime: "22:00", endTime: "06:00" });
    await db.transaction((tx) => setQuietHours(a.actor, tx, null));
    expect((await db.select().from(quietHours).where(eq(quietHours.userId, a.row.id)))[0].enabled).toBe(false);
    await expect(db.transaction((tx) => setQuietHours(a.actor, tx, { start: "25:00", end: "06:00" }))).rejects.toBeInstanceOf(ValidationError);
    await expect(db.transaction((tx) => setQuietHours(a.actor, tx, { start: "07:00", end: "07:00" }))).rejects.toBeInstanceOf(ValidationError);

    await db.transaction((tx) => subscribePush(a.actor, tx, { endpoint: "https://push.example.test/own", keys: { p256dh: "k", auth: "a" } }));
    expect((await db.select().from(pushSubscriptions).where(eq(pushSubscriptions.endpoint, "https://push.example.test/own")))[0].userId).toBe(a.row.id);
    await expect(db.transaction((tx) => subscribePush(a.actor, tx, { endpoint: "http://insecure", keys: { p256dh: "k", auth: "a" } }))).rejects.toBeInstanceOf(ValidationError);

    await run(ev([a.row.id, b.row.id]));
    const mine = (await inbox(a.row.id))[0];
    const theirs = (await inbox(b.row.id))[0];
    await db.transaction((tx) => markRead(a.actor, tx, [mine.id, theirs.id]));
    expect((await inbox(a.row.id))[0].readAt).not.toBeNull();
    expect((await inbox(b.row.id))[0].readAt).toBeNull();
  });
});
