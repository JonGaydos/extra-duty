import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { and, eq, sql } from "drizzle-orm";

const push = vi.hoisted(() => ({ setVapidDetails: vi.fn(), sendNotification: vi.fn() }));
vi.mock("web-push", () => ({ ...push, default: push }));

import { useTestDb } from "../../setup/test-db";
import { useEmailQueue } from "../../setup/email-queue";
import { jobs, jobSafety, notificationPrefs, notifications, pushSubscriptions, users, vendorLocations } from "@/db/schema";
import type { Actor } from "@/domain/actor";
import { assignPerson } from "@/domain/assignments/coordinator";
import { offerSpot } from "@/domain/assignments/giveaway";
import { joinBackup, signUp } from "@/domain/assignments/signup";
import { setConfidential } from "@/domain/jobs/confidential";
import { cancelJob, createJob, updateJob } from "@/domain/jobs/jobs";
import { detailRemindersTick, dueReminder } from "@/domain/jobs/reminders";
import { saveNotificationChannels, updateSettings } from "@/domain/settings/settings";
import { NOTIFY_EMAIL_QUEUE, NOTIFY_PUSH_QUEUE } from "@/jobs/boss";
import { setEmailSender } from "@/lib/email/sender";
import { createMemorySender } from "@/lib/email/types";
import { HOUR, MIN, setupFixture } from "../assignments/helpers";

describe("detail reminders before the start", () => {
  const get = useTestDb();
  const { drainNotifications } = useEmailQueue(get);
  const mail = createMemorySender();
  let f: Awaited<ReturnType<typeof setupFixture>>;
  const warn = { warningVersion: 1 };

  beforeAll(async () => {
    f = await setupFixture(get().db, "rm");
  });
  beforeEach(async () => {
    mail.clear();
    setEmailSender(mail);
    push.sendNotification.mockReset();
    process.env.VAPID_PUBLIC_KEY = "pub";
    process.env.VAPID_PRIVATE_KEY = "priv";
    process.env.VAPID_SUBJECT = "mailto:ops@example.test";
    await drainNotifications();
    await get().db.execute(sql`delete from pgboss.job where name in (${NOTIFY_EMAIL_QUEUE}, ${NOTIFY_PUSH_QUEUE})`);
  });
  afterEach(async () => {
    // Each test's details are put away, so the next test's ticks see only its own.
    await get().db.update(jobs).set({ state: "canceled" });
    await f.run((tx) => updateSettings(f.coord, tx, { detailReminderHours: [72, 24] }));
    await f.run((tx) => saveNotificationChannels(f.coord, tx, { "job.reminder": { personnel: { email: true, push: true } } }));
  });

  const sign = (a: Actor, positionId: string, now: Date) => f.run((tx) => signUp(a, tx, positionId, { ...warn, now }));
  const reminders = async (userId: string) =>
    (await get().db.select().from(notifications).where(and(eq(notifications.userId, userId), eq(notifications.type, "job.reminder")))).map((n) => n.title);
  const at = (job: { startAt: Date }, hoursBefore: number, plusMin = 1) => new Date(job.startAt.getTime() - hoursBefore * HOUR + plusMin * MIN);
  const mailTo = async (email: string) => {
    await drainNotifications();
    return mail.sent.filter((m) => m.to.includes(email));
  };
  const emailOf = async (a: Actor) => (await get().db.select({ email: users.email }).from(users).where(eq(users.id, a.userId)))[0].email;

  /** A detail with a location, description, note, safety notes and site contact, and one person on it. */
  async function detail(o: { reminderHours?: number[] | null; note?: string | null } = {}) {
    const { job, positionId } = await f.mkJob();
    const [loc] = await get().db.insert(vendorLocations).values({ vendorId: f.vendorId, name: "North Field", address: "100 Main St, Springfield", lat: 39.8, lng: -89.6 }).returning();
    await get()
      .db.update(jobs)
      .set({ locationId: loc.id, description: "Traffic control at the north gate.", reminderNote: o.note === undefined ? "Check in with the gate officer." : o.note, reminderHours: o.reminderHours ?? null, contactName: "Sam Site", contactPhone: "555-201-3344" })
      .where(eq(jobs.id, job.id));
    await get().db.insert(jobSafety).values({ jobId: job.id, notes: "Busy road, wear the vest." });
    const person = await f.person();
    await sign(person, positionId, new Date(job.startAt.getTime() - 100 * HOUR));
    return { job, positionId, person };
  }

  test("each reminder time fires once, to the people on the detail, with the description and the note", async () => {
    const d = await detail();
    expect(await detailRemindersTick(at(d.job, 80))).toBe(0);
    expect(await detailRemindersTick(at(d.job, 72))).toBe(1);
    // A second run (a restart, a repeated tick) sends nothing more.
    expect(await detailRemindersTick(at(d.job, 72, 2))).toBe(0);
    expect(await detailRemindersTick(at(d.job, 50))).toBe(0);
    expect(await detailRemindersTick(at(d.job, 24))).toBe(1);
    expect(await detailRemindersTick(at(d.job, 23))).toBe(0);
    expect(await reminders(d.person.userId)).toHaveLength(2);

    const sent = await mailTo(await emailOf(d.person));
    expect(sent).toHaveLength(2);
    const text = sent[0].text;
    expect(sent[0].subject).toMatch(new RegExp(`^Reminder: Detail #${d.job.number} Stadium security on `));
    for (const part of [
      `Detail #${d.job.number}, Stadium security, for rm Vendor`,
      "Where: North Field, 100 Main St, Springfield",
      "Open in Maps: https://www.google.com/maps/search/?api=1&query=39.8%2C-89.6",
      "Position: Deputy Sheriff. Pay: $420 at $70/hr",
      "About the detail: Traffic control at the north gate.",
      "Note: Check in with the gate officer.",
      "Officer safety: Busy road, wear the vest.",
      "Site contact: Sam Site, 555-201-3344",
      `/jobs/${d.job.id}`,
      "(agency time)",
    ])
      expect(text).toContain(part);
    expect(sent[0].html).toContain("Check in with the gate officer.");
  });

  test("the Open in Maps link follows the person's saved maps app", async () => {
    const d = await detail();
    await get().db.update(users).set({ preferredMapsApp: "osm" }).where(eq(users.id, d.person.userId));
    await detailRemindersTick(at(d.job, 72));
    const [m] = await mailTo(await emailOf(d.person));
    expect(m.text).toContain("Open in Maps: https://www.openstreetmap.org/?mlat=39.8&mlon=-89.6");
  });

  test("a detail's own times replace the agency's, and off sends nothing", async () => {
    const own = await detail({ reminderHours: [2] });
    expect(await detailRemindersTick(at(own.job, 72))).toBe(0);
    expect(await detailRemindersTick(at(own.job, 24))).toBe(0);
    expect(await detailRemindersTick(at(own.job, 2))).toBe(1);
    const off = await detail({ reminderHours: [] });
    for (const h of [72, 48, 24, 2]) expect(await detailRemindersTick(at(off.job, h))).toBe(0);
    expect(await reminders(off.person.userId)).toEqual([]);
  });

  test("the agency setting applies to details that keep it", async () => {
    await f.run((tx) => updateSettings(f.coord, tx, { detailReminderHours: [48] }));
    const d = await detail();
    expect(await detailRemindersTick(at(d.job, 72))).toBe(0);
    expect(await detailRemindersTick(at(d.job, 48))).toBe(1);
    expect(await detailRemindersTick(at(d.job, 24))).toBe(0);
    await expect(f.run((tx) => updateSettings(f.coord, tx, { detailReminderHours: [12] }))).rejects.toThrow(/Choose from 72, 48, 24, 2 hours/);
  });

  test("someone assigned after a reminder went out does not get it, but gets the next", async () => {
    const d = await detail();
    const { job, positionId } = d;
    await get().db.execute(sql`update job_positions set count = 2 where id = ${positionId}`);
    await detailRemindersTick(at(job, 72));
    const late = await f.person();
    await sign(late, positionId, at(job, 60));
    expect(await detailRemindersTick(at(job, 59))).toBe(0);
    expect(await reminders(late.userId)).toEqual([]);
    expect(await detailRemindersTick(at(job, 24))).toBe(2);
    expect(await reminders(late.userId)).toHaveLength(1);
  });

  test("only the latest due reminder goes out after a gap, and none from before the detail was made", () => {
    const created = new Date("2035-01-10T13:00:00Z");
    const job = { startAt: new Date("2035-01-13T12:00:00Z"), createdAt: created };
    // Both 72 and 24 are due and unsent: only 24 goes; 72 is passed over.
    expect(dueReminder(job, [72, 24], [], new Date("2035-01-12T13:00:00Z"))).toEqual({ send: 24, passed: [] });
    expect(dueReminder({ ...job, createdAt: new Date("2035-01-09T12:00:00Z") }, [72, 24], [], new Date("2035-01-12T13:00:00Z"))).toEqual({ send: 24, passed: [72] });
    // The 72-hour mark was before the detail existed.
    expect(dueReminder({ ...job, createdAt: new Date("2035-01-11T12:00:00Z") }, [72], [], new Date("2035-01-11T13:00:00Z"))).toBeNull();
  });

  test("a time change moves the reminders still to come", async () => {
    const d = await detail();
    await detailRemindersTick(at(d.job, 72));
    const later = { startAt: new Date(d.job.startAt.getTime() + 48 * HOUR), endAt: new Date(d.job.endAt.getTime() + 48 * HOUR) };
    await f.run((tx) => updateJob(f.coord, tx, d.job.id, later, "one"));
    // The 72-hour reminder went out too early for the new time, so the new 72-hour mark sends it again.
    expect(await detailRemindersTick(at(later, 73))).toBe(0);
    expect(await detailRemindersTick(at(later, 72))).toBe(1);
    expect(await detailRemindersTick(at(later, 24))).toBe(1);
    expect(await reminders(d.person.userId)).toHaveLength(3);
    // Moving it earlier again does not repeat a reminder already had.
    const earlier = { startAt: new Date(later.startAt.getTime() - 2 * HOUR), endAt: new Date(later.endAt.getTime() - 2 * HOUR) };
    await f.run((tx) => updateJob(f.coord, tx, d.job.id, earlier, "one"));
    expect(await detailRemindersTick(at(earlier, 20))).toBe(0);
  });

  test("canceled and held details send nothing", async () => {
    const canceled = await detail();
    await f.run((tx) => cancelJob(f.coord, tx, canceled.job.id, "Event moved"));
    const held = await detail();
    await get().db.update(jobs).set({ held: true }).where(eq(jobs.id, held.job.id));
    for (const h of [72, 24]) {
      expect(await detailRemindersTick(at(canceled.job, h))).toBe(0);
      expect(await detailRemindersTick(at(held.job, h))).toBe(0);
    }
    expect(await reminders(canceled.person.userId)).toEqual([]);
    expect(await reminders(held.person.userId)).toEqual([]);
  });

  test("a spot the deputy offered still gets reminders; backups do not", async () => {
    const d = await detail();
    const backup = await f.person();
    await f.run((tx) => joinBackup(backup, tx, d.positionId, { ...warn, now: at(d.job, 95) }));
    const mine = (await get().db.execute<{ id: string }>(sql`select id from assignments where job_id = ${d.job.id} and status = 'signed_up'`)).rows[0].id;
    await f.run((tx) => offerSpot(d.person, tx, mine, "Family event", at(d.job, 90)));
    expect(await detailRemindersTick(at(d.job, 72))).toBe(1);
    expect(await reminders(d.person.userId)).toHaveLength(1);
    expect(await reminders(backup.userId)).toEqual([]);
  });

  test("the agency switch and the person's own choice decide the email; the inbox always has it", async () => {
    await f.run((tx) => saveNotificationChannels(f.coord, tx, { "job.reminder": { personnel: { email: false } } }));
    const a = await detail();
    await detailRemindersTick(at(a.job, 72));
    expect(await reminders(a.person.userId)).toHaveLength(1);
    expect(await mailTo(await emailOf(a.person))).toEqual([]);

    await f.run((tx) => saveNotificationChannels(f.coord, tx, { "job.reminder": { personnel: { email: true } } }));
    const b = await detail();
    await get().db.insert(notificationPrefs).values({ userId: b.person.userId, type: "job.reminder", email: false, push: false });
    await detailRemindersTick(at(b.job, 72));
    expect(await reminders(b.person.userId)).toHaveLength(1);
    expect(await mailTo(await emailOf(b.person))).toEqual([]);
  });

  test("a confidential detail's email and push say only the date and time; the inbox keeps the full reminder", async () => {
    const { job, positionId } = await f.mkJob();
    await get().db.update(jobs).set({ description: "Motorcade route.", reminderNote: "Meet at the hangar." }).where(eq(jobs.id, job.id));
    await f.run((tx) => setConfidential(f.coord, tx, job.id, true, "Dignitary visit"));
    const person = await f.person();
    await f.run((tx) => assignPerson(f.coord, tx, positionId, person.userId, { notify: false, now: at(job, 100) }));
    await get().db.insert(pushSubscriptions).values({ userId: person.userId, endpoint: `https://push.example.test/${person.userId}`, keys: { p256dh: "k", auth: "a" } });
    expect(await detailRemindersTick(at(job, 72))).toBe(1);
    const [m] = await mailTo(await emailOf(person));
    expect(m.text).toMatch(/^Reminder: you are assigned to a confidential detail on [A-Z][a-z]{2} \d{1,2}, 2035 at 5:00 PM\. Open Signal 90 for the details\./);
    for (const secret of ["Stadium security", "Motorcade", "hangar", "rm Vendor"]) {
      expect(m.text).not.toContain(secret);
      expect(m.subject).not.toContain(secret);
    }
    const payload = JSON.parse(push.sendNotification.mock.calls[0][1] as string) as { title: string; body: string };
    expect(payload.body).toContain("confidential detail");
    expect(JSON.stringify(payload)).not.toContain("Stadium");
    expect((await reminders(person.userId))[0]).toBe(`Reminder: #${job.number} Stadium security`);
  });

  test("a detail made with its own times and note keeps them", async () => {
    const { job } = await f.mkJob();
    const made = await f.run((tx) =>
      createJob(f.coord, tx, {
        vendorId: job.vendorId,
        locationId: null,
        typeId: job.typeId,
        title: "Parade",
        description: null,
        notes: null,
        startAt: job.startAt,
        endAt: job.endAt,
        rateCents: null,
        opsPlanRequired: false,
        opsPlanDueAt: null,
        contactName: null,
        contactPhone: null,
        held: false,
        reminderHours: [24, 72],
        reminderNote: "  Park behind the school.  ",
      }),
    );
    expect(made).toMatchObject({ reminderHours: [72, 24], reminderNote: "Park behind the school." });
    await expect(f.run((tx) => updateJob(f.coord, tx, made.id, { reminderHours: [5] }, "one"))).rejects.toThrow(/Choose from/);
    const [after] = await f.run((tx) => updateJob(f.coord, tx, made.id, { reminderHours: [], reminderNote: "" }, "one"));
    expect(after).toMatchObject({ reminderHours: [], reminderNote: null });
  });
});
