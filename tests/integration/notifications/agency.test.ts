import { beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { and, eq, sql } from "drizzle-orm";

const push = vi.hoisted(() => ({ setVapidDetails: vi.fn(), sendNotification: vi.fn() }));
vi.mock("web-push", () => ({ ...push, default: push }));

import { useTestDb } from "../../setup/test-db";
import { useEmailQueue } from "../../setup/email-queue";
import { makeUser } from "../users/helpers";
import { assignments, auditLog, invoices, notificationPrefs, notifications, pushSubscriptions, vendors, vendorUsers } from "@/db/schema";
import { cancelJob } from "@/domain/jobs/jobs";
import { vendorCancelJob } from "@/domain/vendor-portal/requests";
import type { Actor } from "@/domain/actor";
import { ForbiddenError, ValidationError } from "@/domain/errors";
import { agencyNotificationSettings, agencyTurnedOff, saveAgencyNotifications } from "@/domain/notifications/agency";
import { decodeNotifyJob, emit, type NotifyJob } from "@/domain/notifications/notify";
import { DEFAULT_CHANNELS, NOTIFICATION_TYPES } from "@/domain/notifications/types";
import { alertSettings } from "@/domain/personnel/views";
import { suspendUser } from "@/domain/users/suspension";
import { vendorEmail } from "@/domain/payment-issues/issues";
import { getSettings, updateSettings } from "@/domain/settings/settings";
import { EMAIL_QUEUE, NOTIFY_EMAIL_QUEUE, NOTIFY_PUSH_QUEUE } from "@/jobs/boss";
import { setEmailSender } from "@/lib/email/sender";
import { createMemorySender } from "@/lib/email/types";
import { setupFixture } from "../assignments/helpers";

describe("agency notification settings", () => {
  const get = useTestDb();
  const { drainNotifications, drain } = useEmailQueue(get);
  const mail = createMemorySender();
  let n = 0;
  let admin: Actor;
  let coord: Actor;
  let fx: Awaited<ReturnType<typeof setupFixture>>;

  const person = async (role: "personnel" | "coordinator" | "admin" | "vendor" = "personnel") => {
    const u = await makeUser(get().db, role, `ag${++n}@example.test`);
    await get().db.insert(pushSubscriptions).values({ userId: u.row.id, endpoint: `https://push.example.test/${u.row.id}`, keys: { p256dh: "k", auth: "a" } });
    return u;
  };
  const run = (e: Parameters<typeof emit>[1]) => get().db.transaction((tx) => emit(tx, e));
  const ev = (type: (typeof NOTIFICATION_TYPES)[number], recipients: string[], extra: Partial<Parameters<typeof emit>[1]> = {}) => ({ type, recipients, title: "T", body: "B", link: "/x", ...extra });
  const save = (actor: Actor, channels: Parameters<typeof saveAgencyNotifications>[2]) => get().db.transaction((tx) => saveAgencyNotifications(actor, tx, channels));
  const inbox = async (userId: string) => (await get().db.select().from(notifications).where(eq(notifications.userId, userId))).length;
  /** Queued notify jobs per user: how many email and push jobs each has. */
  const queued = async () => {
    const rows = (await get().db.execute(sql`select name, data from pgboss.job where name in (${NOTIFY_EMAIL_QUEUE}, ${NOTIFY_PUSH_QUEUE})`)).rows as Array<{ name: string; data: NotifyJob }>;
    const out = new Map<string, { email: number; push: number }>();
    for (const r of rows) {
      const c = decodeNotifyJob(r.data);
      const cur = out.get(c.userId) ?? { email: 0, push: 0 };
      if (r.name === NOTIFY_EMAIL_QUEUE) cur.email++;
      else cur.push++;
      out.set(c.userId, cur);
    }
    return out;
  };
  const clearQueue = () => get().db.execute(sql`delete from pgboss.job where name in (${NOTIFY_EMAIL_QUEUE}, ${NOTIFY_PUSH_QUEUE}, ${EMAIL_QUEUE})`);

  beforeAll(async () => {
    const { db } = get();
    fx = await setupFixture(db, "ag");
    admin = (await makeUser(db, "admin", "ag-admin@example.test")).actor;
    coord = fx.coord;
  });

  beforeEach(async () => {
    mail.clear();
    setEmailSender(mail);
    // Every test starts from the defaults: nothing stored, so every switch is on.
    await get().db.execute(sql`update settings set value = value - 'notificationChannels'`);
    await drain();
    await clearQueue();
  });

  test("an agency switch that is off blocks that channel for that group only, and the inbox still records it", async () => {
    const deputy = await person("personnel");
    const staff = await person("coordinator");
    await save(coord, { "invoice.email_failed": { staff: { email: false }, personnel: { push: false } } });
    await run(ev("invoice.email_failed", [deputy.row.id, staff.row.id]));
    const q = await queued();
    expect(q.get(deputy.row.id)).toEqual({ email: 1, push: 0 });
    expect(q.get(staff.row.id)).toEqual({ email: 0, push: 1 });
    expect(await inbox(deputy.row.id)).toBe(1);
    expect(await inbox(staff.row.id)).toBe(1);
  });

  test("vendor email off for Detail reactivated: the vendor gets the inbox entry and no email; deputies still get theirs", async () => {
    const vendor = await person("vendor");
    const deputy = await person("personnel");
    await save(admin, { "job.reactivated": { vendor: { email: false } } });
    await run(ev("job.reactivated", [vendor.row.id, deputy.row.id]));
    const q = await queued();
    expect(q.get(vendor.row.id)).toBeUndefined();
    expect(q.get(deputy.row.id)).toEqual({ email: 1, push: 1 });
    expect(await inbox(vendor.row.id)).toBe(1);
    await drainNotifications();
    expect(mail.sent.map((m) => m.to)).toEqual([[deputy.row.email]]);
  });

  test("a coordinator on a detail counts as personnel for detail alerts", async () => {
    const staff = await person("coordinator");
    await save(admin, { "job.changed": { personnel: { email: false } } });
    await run(ev("job.changed", [staff.row.id]));
    expect((await queued()).get(staff.row.id)).toEqual({ email: 0, push: 1 });
  });

  test("personal preferences still apply when the agency switch is on", async () => {
    const deputy = await person("personnel");
    await get().db.insert(notificationPrefs).values({ userId: deputy.row.id, type: "job.changed", email: false, push: true });
    await run(ev("job.changed", [deputy.row.id]));
    expect((await queued()).get(deputy.row.id)).toEqual({ email: 0, push: 1 });
  });

  test("direct messages from coordinators always arrive; other messages follow the agency switch", async () => {
    const deputy = await person("personnel");
    await save(admin, { "message.received": { personnel: { email: false, push: false } } });
    await run(ev("message.received", [deputy.row.id]));
    expect((await queued()).get(deputy.row.id)).toBeUndefined();
    await run(ev("message.received", [deputy.row.id], { mandatory: true }));
    expect((await queued()).get(deputy.row.id)).toEqual({ email: 1, push: 1 });
    expect(await inbox(deputy.row.id)).toBe(2);
  });

  test("other coordinator-sent alerts skip personal choices but follow the agency switch", async () => {
    const deputy = await person("personnel");
    await get().db.insert(notificationPrefs).values({ userId: deputy.row.id, type: "assignment.assigned", email: false, push: false });
    await save(admin, { "assignment.assigned": { personnel: { push: false } } });
    await run(ev("assignment.assigned", [deputy.row.id], { mandatory: true }));
    expect((await queued()).get(deputy.row.id)).toEqual({ email: 1, push: 0 });
  });

  test("with default settings the same notifications go out as before, for every type and group", async () => {
    const vendor = await person("vendor");
    const deputy = await person("personnel");
    const staff = await person("coordinator");
    for (const type of NOTIFICATION_TYPES) {
      await clearQueue();
      await run(ev(type, [vendor.row.id, deputy.row.id, staff.row.id]));
      const q = await queued();
      const d = DEFAULT_CHANNELS[type];
      // Today's rule: email per the default choice for everyone; push per the default, never to vendors.
      const want = (role: string) => {
        const r = { email: d.email ? 1 : 0, push: role !== "vendor" && d.push ? 1 : 0 };
        return r.email || r.push ? r : undefined;
      };
      expect(q.get(vendor.row.id), `${type} vendor`).toEqual(want("vendor"));
      expect(q.get(deputy.row.id), `${type} personnel`).toEqual(want("personnel"));
      expect(q.get(staff.row.id), `${type} staff`).toEqual(want("staff"));
    }
  });

  test("staff canceling a detail tell the vendor's logins (the one deliberate addition to today's alerts); the vendor canceling it does not", async () => {
    const { db } = get();
    const login = await person("vendor");
    await db.insert(vendorUsers).values({ userId: login.row.id, vendorId: fx.vendorId });
    const vendorActor = { ...login.actor, vendorId: fx.vendorId };
    const vendorInbox = () => db.select().from(notifications).where(and(eq(notifications.userId, login.row.id), eq(notifications.type, "job.canceled")));

    const { job } = await fx.mkJob();
    await db.transaction((tx) => cancelJob(coord, tx, job.id, "Lot closed after a suspension"));
    const [row] = await vendorInbox();
    expect(row.title).toBe("Detail canceled");
    expect(row.body).toBe(`Detail #${job.number} on ${new Intl.DateTimeFormat("en-US", { timeZone: "America/Chicago", dateStyle: "medium" }).format(job.startAt)} was canceled.`);
    expect(row.body).not.toMatch(/Lot closed|suspen/i);
    // On by default: the vendor login's email is queued.
    expect((await queued()).get(login.row.id)).toEqual({ email: 1, push: 0 });

    // Vendor email off: the inbox row is still written, no email.
    await clearQueue();
    await save(admin, { "job.canceled": { vendor: { email: false } } });
    const second = await fx.mkJob();
    await db.transaction((tx) => cancelJob(admin, tx, second.job.id, "Rain"));
    expect(await vendorInbox()).toHaveLength(2);
    expect((await queued()).get(login.row.id)).toBeUndefined();

    // The vendor canceling its own detail is not told about it.
    const third = await fx.mkJob();
    await db.transaction((tx) => vendorCancelJob(vendorActor, tx, third.job.id, "No longer needed", new Date("2035-01-01T12:00:00Z")));
    expect(await vendorInbox()).toHaveLength(2);
  });

  test("locked types cannot be turned off, by the service or by a settings patch", async () => {
    await expect(save(admin, { "auth.sign_in_code": { personnel: { email: false } } })).rejects.toThrow(ValidationError);
    await expect(save(coord, { "invoice.delivery": { vendor: { email: false } } })).rejects.toThrow(/This email is the invoice/);
    await expect(get().db.transaction((tx) => updateSettings(admin, tx, { notificationChannels: { "auth.invite": { vendor: { email: false } } } }))).rejects.toThrow(ValidationError);
    expect((await get().db.transaction((tx) => getSettings(tx))).notificationChannels).toEqual({});
  });

  test("every change is audited with before and after", async () => {
    const { db } = get();
    const since = new Date();
    await save(coord, { "job.canceled": { personnel: { push: false } } });
    const [row] = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, "settings.notifications"), eq(auditLog.actorUserId, coord.userId), sql`${auditLog.at} >= ${since}`));
    expect(row.before).toEqual({ notificationChannels: {} });
    expect(row.after).toEqual({ notificationChannels: { "job.canceled": { personnel: { push: false } } } });
  });

  test("admins and coordinators can read and edit; personnel and vendors are forbidden", async () => {
    const deputy = (await person("personnel")).actor;
    const vendorLogin = (await person("vendor")).actor;
    for (const a of [deputy, vendorLogin]) {
      await expect(save(a, { "job.changed": { personnel: { email: false } } })).rejects.toThrow(ForbiddenError);
      await expect(get().db.transaction((tx) => agencyNotificationSettings(a, tx))).rejects.toThrow(ForbiddenError);
    }
    await save(coord, { "job.changed": { personnel: { email: false } } });
    const view = await get().db.transaction((tx) => agencyNotificationSettings(admin, tx));
    expect(view.channels["job.changed"]?.personnel?.email).toBe(false);
  });

  test("the personal alert settings say which channels the agency turned off", async () => {
    const deputy = await person("personnel");
    await save(admin, { "job.changed": { personnel: { email: false } }, "billing.ready": { personnel: { push: false } } });
    const s = await get().db.transaction((tx) => alertSettings(deputy.actor, tx));
    expect(s.agencyOff["job.changed"]).toEqual({ email: true, push: false });
    expect(s.agencyOff["billing.ready"]).toEqual({ email: false, push: true });
    expect(s.agencyOff["job.canceled"]).toBeUndefined();
    const off = await get().db.transaction((tx) => agencyTurnedOff(tx, "coordinator"));
    expect(off["job.changed"]).toEqual({ email: true, push: false });
  });

  test("the vendor payment-issue email follows the agency switch", async () => {
    const { db } = get();
    await db.update(vendors).set({ billingEmails: ["ap@ag-vendor.example"] }).where(eq(vendors.id, fx.vendorId));
    const p = await fx.person();
    const { job, positionId } = await fx.mkJob();
    const [a] = await db.insert(assignments).values({ jobId: job.id, jobPositionId: positionId, userId: p.userId, status: "signed_up" }).returning();
    const [inv] = await db.insert(invoices).values({ assignmentId: a.id, vendorId: fx.vendorId, payeeUserId: p.userId, minutes: 240, rateCents: 7000, totalCents: 28000, status: "sent" }).returning();
    await save(admin, { "payment_issue.waiting_on": { vendor: { email: false } } });
    expect(await db.transaction((tx) => vendorEmail(tx, inv, "payment_issue.waiting_on", "Subject", "Intro"))).toBe("off");
    await save(admin, { "payment_issue.waiting_on": { vendor: { email: true } }, "invoice.vendor_payment_reminder": { vendor: { email: false } } });
    expect(await db.transaction((tx) => vendorEmail(tx, inv, "invoice.vendor_payment_reminder", "Subject", "Intro"))).toBe("off");
    expect(await db.transaction((tx) => vendorEmail(tx, inv, "payment_issue.waiting_on", "Subject", "Intro"))).toBe("sent");
    await drain();
    expect(mail.sent.map((m) => m.subject)).toEqual(["Subject"]);
  });

  test("a suspension notice goes to the deputy's inbox only: never email or push, whatever the agency or the deputy chose", async () => {
    const deputy = await person("personnel");
    // The deputy asked for email and push; the agency cannot turn either on for this type.
    await get().db.insert(notificationPrefs).values({ userId: deputy.row.id, type: "user.suspended", email: true, push: true });
    await expect(save(coord, { "user.suspended": { personnel: { email: true } } })).rejects.toBeInstanceOf(ValidationError);
    await expect(save(coord, { "user.suspended": { personnel: { push: true } } })).rejects.toBeInstanceOf(ValidationError);
    await get().db.transaction((tx) => suspendUser(coord, tx, deputy.row.id, { reason: "Policy review", until: null, removeFutureAssignments: false }));
    const rows = await get().db.select().from(notifications).where(and(eq(notifications.userId, deputy.row.id), eq(notifications.type, "user.suspended")));
    expect(rows).toHaveLength(1);
    expect((await queued()).get(deputy.row.id)).toBeUndefined();
    await drainNotifications();
    expect(mail.sent.filter((m) => m.to.includes(deputy.row.email))).toHaveLength(0);
    expect(push.sendNotification).not.toHaveBeenCalledWith(expect.objectContaining({ endpoint: `https://push.example.test/${deputy.row.id}` }), expect.anything(), expect.anything());
    // The deputy's own alert page offers nothing to switch for it, and the agency page shows it as off.
    expect((await get().db.transaction((tx) => agencyTurnedOff(tx, "personnel")))["user.suspended"]).toBeUndefined();
  });
});
