import sharp from "sharp";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, test } from "vitest";
import { eq } from "drizzle-orm";
import { useEmailQueue } from "../../setup/email-queue";
import { useTestDb } from "../../setup/test-db";
import { makeUser } from "../users/helpers";
import { auditLog, qualificationRequests, qualifications, userQualifications } from "@/db/schema";
import { seed } from "@/db/seed";
import type { Actor } from "@/domain/actor";
import { decideQualificationRequest, grantQualification, revokeQualification } from "@/domain/jobs/qualifications";
import { accessReviewOverview, auditView, flagOverview, flagRecord, userDirectory, userRecord } from "@/domain/admin/views";
import { ForbiddenError, ValidationError } from "@/domain/errors";
import { agencyLogoInfo, readAgencyLogo, removeAgencyLogo, setAgencyLogo } from "@/domain/settings/logo";
import { storeFile } from "@/domain/files/files";
import { getSettings, updateSettings } from "@/domain/settings/settings";
import { sendTestEmail } from "@/domain/settings/test-email";
import { decideAccessReviewItem, startAccessReview } from "@/domain/users/access-review";
import { suspendUser } from "@/domain/users/suspension";
import { createLocalStorage } from "@/lib/storage/local";
import { createMemorySender } from "@/lib/email/types";
import { createInvite } from "@/domain/auth/invites";
import { jobs, vendors, jobTypes } from "@/db/schema";
import { releaseAt } from "@/domain/release/release";
import { agencyDateParts, agencyInstant } from "@/domain/time/agency-time";
import { GROUPS, groupValues } from "@/app/(app)/admin/_admin/settings-groups";
import { saveGroup } from "@/app/(app)/admin/_admin/settings-save";

// Fake email senders and fetches are async to match the real ones; they answer at once.

let PNG: Buffer;
const SVG = Buffer.from('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" width="40" height="20"><rect width="40" height="20" fill="#123c8c"/></svg>');

describe("management read models and services", () => {
  const get = useTestDb();
  useEmailQueue(get);
  let admin: Actor;
  let coordinator: Actor;
  let personnel: Actor;
  let adminId: string;
  let deputyId: string;
  const storage = createLocalStorage(mkdtempSync(join(tmpdir(), "ed-logo-")));

  beforeAll(async () => {
    const { db } = get();
    PNG = await sharp({ create: { width: 40, height: 20, channels: 3, background: "#123c8c" } }).png().toBuffer();
    await seed(db);
    const a = await makeUser(db, "admin", "admin@example.test");
    admin = a.actor;
    adminId = a.row.id;
    coordinator = (await makeUser(db, "coordinator", "coord@example.test")).actor;
    const d = await makeUser(db, "personnel", "deputy@example.test");
    personnel = d.actor;
    deputyId = d.row.id;
    await makeUser(db, "vendor", "vendor@example.test");
  });

  test("the user directory lists staff, not vendor logins, and marks suspensions", async () => {
    const { db } = get();
    await db.transaction((tx) => suspendUser(coordinator, tx, deputyId, { reason: "Late twice.", until: new Date(Date.now() + 86_400_000), removeFutureAssignments: false }));
    const list = await db.transaction((tx) => userDirectory(coordinator, tx));
    expect(list.map((u) => u.email)).not.toContain("vendor@example.test");
    expect(list.find((u) => u.id === deputyId)?.suspended).toBe(true);
    await expect(db.transaction((tx) => userDirectory(personnel, tx))).rejects.toBeInstanceOf(ForbiddenError);
  });

  test("a coordinator may read an admin account but not change it", async () => {
    const { db } = get();
    expect((await db.transaction((tx) => userRecord(coordinator, tx, adminId))).canChange).toBe(false);
    expect((await db.transaction((tx) => userRecord(admin, tx, adminId))).canChange).toBe(true);
    expect((await db.transaction((tx) => userRecord(coordinator, tx, deputyId))).canChange).toBe(true);
  });

  test("flags show holder counts, pending requests and who can still be granted one", async () => {
    const { db } = get();
    const [k9] = await db.select().from(qualifications).where(eq(qualifications.name, "K9"));
    await db.insert(userQualifications).values({ userId: deputyId, qualificationId: k9.id });
    const [motors] = await db.select().from(qualifications).where(eq(qualifications.name, "Motors"));
    await db.insert(qualificationRequests).values({ userId: deputyId, qualificationId: motors.id, note: "Course done." });
    const o = await db.transaction((tx) => flagOverview(coordinator, tx));
    expect(o.flags.find((f) => f.name === "K9")?.holders).toBe(1);
    expect(o.flags.find((f) => f.name === "Motors")?.holders).toBe(0);
    expect(o.requests).toMatchObject([{ userId: deputyId, flagName: "Motors", note: "Course done." }]);
    const r = await db.transaction((tx) => flagRecord(coordinator, tx, k9.id));
    expect(r.holders.map((h) => h.userId)).toEqual([deputyId]);
    expect(r.candidates.map((c) => c.id)).not.toContain(deputyId);
    // Coordinators cannot change admin accounts, so admins are not offered to them.
    expect(r.candidates.map((c) => c.id)).not.toContain(adminId);
    expect((await db.transaction((tx) => flagRecord(admin, tx, k9.id))).candidates.map((c) => c.id)).toContain(adminId);
  });

  test("a coordinator starts an access review; the overview lists who is left and the audit names them", async () => {
    const { db } = get();
    const review = await db.transaction((tx) => startAccessReview(tx, new Date(), coordinator));
    expect(review).not.toBeNull();
    await expect(db.transaction((tx) => startAccessReview(tx, new Date(), personnel))).rejects.toBeInstanceOf(ForbiddenError);
    let o = await db.transaction((tx) => accessReviewOverview(coordinator, tx));
    expect(o.open?.total).toBe(4);
    const item = o.open!.pending.find((p) => p.userId === deputyId)!;
    await db.transaction((tx) => decideAccessReviewItem(coordinator, tx, item.itemId, { decision: "keep" }));
    o = await db.transaction((tx) => accessReviewOverview(coordinator, tx));
    expect(o.open?.decided).toBe(1);
    expect(o.open?.pending.map((p) => p.userId)).not.toContain(deputyId);
    const [start] = await db.select().from(auditLog).where(eq(auditLog.action, "access_review.start"));
    expect(start.actorUserId).toBe(coordinator.userId);
  });

  test("the audit view filters by record type and names the actor", async () => {
    const { db } = get();
    const v = await db.transaction((tx) => auditView(coordinator, tx, { entityType: "user" }, 1));
    expect(v.rows.length).toBeGreaterThan(0);
    expect(v.rows.every((r) => r.entityType === "user")).toBe(true);
    expect(v.rows.find((r) => r.action === "user.suspend")?.actorName).toBe("coord");
    expect(v.types).toContain("access_review");
    expect(v.hasMore).toBe(false);
  });

  test("a PNG logo is kept, an SVG is drawn to a PNG, and anything else is refused", async () => {
    const { db } = get();
    const png = await db.transaction((tx) => setAgencyLogo(coordinator, tx, { filename: "badge.png", body: PNG }, storage));
    expect(png.contentType).toBe("image/png");
    let logo = await db.transaction((tx) => readAgencyLogo(tx, storage));
    // Redrawn, not stored as uploaded.
    expect(logo?.body.subarray(0, 4).toString("hex")).toBe("89504e47");

    const svg = await db.transaction((tx) => setAgencyLogo(coordinator, tx, { filename: "star.svg", body: SVG }, storage));
    expect(svg.filename).toBe("star.png");
    logo = await db.transaction((tx) => readAgencyLogo(tx, storage));
    expect(logo?.id).toBe(svg.id);
    expect(logo?.body.subarray(0, 4).toString("hex")).toBe("89504e47");
    expect((await db.transaction((tx) => getSettings(tx))).agency.logoFileId).toBe(svg.id);

    await expect(db.transaction((tx) => setAgencyLogo(coordinator, tx, { filename: "x.txt", body: Buffer.from("hello") }, storage))).rejects.toThrow("Upload a PNG, SVG, JPG or WebP file.");
    await expect(db.transaction((tx) => setAgencyLogo(personnel, tx, { filename: "badge.png", body: PNG }, storage))).rejects.toBeInstanceOf(ForbiddenError);
    await db.transaction((tx) => removeAgencyLogo(coordinator, tx));
    expect(await db.transaction((tx) => readAgencyLogo(tx, storage))).toBeNull();
  });

  test("an uploaded logo keeps its trimmed size in settings, for the square or wide slot", async () => {
    const { db } = get();
    const wide = await sharp({ create: { width: 900, height: 500, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
      .composite([{ input: await sharp({ create: { width: 600, height: 200, channels: 4, background: "#123c8c" } }).png().toBuffer(), gravity: "centre" }])
      .png()
      .toBuffer();
    const row = await db.transaction((tx) => setAgencyLogo(coordinator, tx, { filename: "wide.png", body: wide }, storage));
    const s = (await db.transaction((tx) => getSettings(tx))).agency;
    expect(s).toMatchObject({ logoFileId: row.id, logoWidth: 512, logoHeight: 171, logoTransparent: true });
    expect(await db.transaction((tx) => agencyLogoInfo(tx, storage))).toEqual({ fileId: row.id, width: 512, height: 171, transparent: true });
    await db.transaction((tx) => removeAgencyLogo(coordinator, tx));
    expect((await db.transaction((tx) => getSettings(tx))).agency).toMatchObject({ logoFileId: null, logoWidth: null, logoHeight: null, logoTransparent: null });
    expect(await db.transaction((tx) => agencyLogoInfo(tx, storage))).toBeNull();
  });

  test("a logo saved before sizes were kept is processed once, on first use, and the new file is kept", async () => {
    const { db } = get();
    const padded = await sharp({ create: { width: 400, height: 400, channels: 4, background: "#ffffff" } })
      .composite([{ input: await sharp({ create: { width: 300, height: 100, channels: 4, background: "#123c8c" } }).png().toBuffer(), gravity: "centre" }])
      .png()
      .toBuffer();
    const legacy = await db.transaction((tx) => storeFile(coordinator, tx, { kind: "attachment", filename: "old.png", contentType: "image/png", body: padded }, { only: "png" }, storage));
    await db.transaction((tx) => updateSettings(coordinator, tx, { agency: { logoFileId: legacy.id } }));

    const first = await db.transaction((tx) => agencyLogoInfo(tx, storage));
    expect(first).toMatchObject({ width: 300, height: 100, transparent: false });
    expect(first!.fileId).not.toBe(legacy.id);
    expect((await db.transaction((tx) => getSettings(tx))).agency).toMatchObject({ logoFileId: first!.fileId, logoWidth: 300, logoHeight: 100, logoTransparent: false });
    const upgrades = await db.select().from(auditLog).where(eq(auditLog.action, "settings.logo_upgrade"));
    expect(upgrades).toHaveLength(1);
    expect(upgrades[0].actorUserId).toBeNull();

    expect(await db.transaction((tx) => agencyLogoInfo(tx, storage))).toEqual(first);
    const served = await db.transaction((tx) => readAgencyLogo(tx, storage));
    expect(served?.id).toBe(first!.fileId);
    expect((await sharp(served!.body).metadata()).width).toBe(300);
    expect(await db.select().from(auditLog).where(eq(auditLog.action, "settings.logo_upgrade"))).toHaveLength(1);
    await db.transaction((tx) => removeAgencyLogo(coordinator, tx));
  });

  test("a logo saved with its size but before transparency was kept is measured once, keeping the same file", async () => {
    const { db } = get();
    const clear = await sharp({ create: { width: 400, height: 200, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
      .composite([{ input: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><circle cx="50" cy="50" r="50" fill="#123c8c"/></svg>'), gravity: "centre" }])
      .png()
      .toBuffer();
    const saved = await db.transaction((tx) => storeFile(coordinator, tx, { kind: "attachment", filename: "seal.png", contentType: "image/png", body: clear }, { only: "png" }, storage));
    await db.transaction((tx) => updateSettings(coordinator, tx, { agency: { logoFileId: saved.id, logoWidth: 400, logoHeight: 200, logoTransparent: null } }));
    const before = (await db.select().from(auditLog).where(eq(auditLog.action, "settings.logo_upgrade"))).length;

    const info = await db.transaction((tx) => agencyLogoInfo(tx, storage));
    expect(info).toEqual({ fileId: saved.id, width: 400, height: 200, transparent: true });
    expect((await db.transaction((tx) => getSettings(tx))).agency).toMatchObject({ logoFileId: saved.id, logoTransparent: true });
    expect(await db.select().from(auditLog).where(eq(auditLog.action, "settings.logo_upgrade"))).toHaveLength(before + 1);
    expect(await db.transaction((tx) => agencyLogoInfo(tx, storage))).toEqual(info);
    expect(await db.select().from(auditLog).where(eq(auditLog.action, "settings.logo_upgrade"))).toHaveLength(before + 1);
    await db.transaction((tx) => removeAgencyLogo(coordinator, tx));
  });

  test("a test email goes to the admin's own address through the saved settings; coordinators are refused", async () => {
    const { db } = get();
    const sender = createMemorySender();
    await expect(sendTestEmail(admin, (fn) => db.transaction(fn), () => sender)).rejects.toBeInstanceOf(ValidationError);
    await db.transaction((tx) => updateSettings(admin, tx, { email: { provider: "smtp", from: "Signal 90 <noreply@example.test>", smtp: { host: "mail.example.test" } } }));
    expect(await sendTestEmail(admin, (fn) => db.transaction(fn), () => sender)).toBe("admin@example.test");
    expect(sender.sent).toHaveLength(1);
    expect(sender.sent[0]).toMatchObject({ to: ["admin@example.test"], subject: "Signal 90 test email" });
    expect(sender.sent[0].text).toContain("goes out through the email server mail.example.test. If you can read this, it works.");
    await expect(sendTestEmail(coordinator, (fn) => db.transaction(fn), () => sender)).rejects.toBeInstanceOf(ForbiddenError);
    const failing = { send: () => Promise.reject(new Error("connection refused")) };
    await expect(sendTestEmail(admin, (fn) => db.transaction(fn), () => failing)).rejects.toThrow("The test email was not sent: connection refused");
    await db.transaction((tx) => updateSettings(admin, tx, { email: { provider: "postmark", apiKey: "test-token" } }));
    await sendTestEmail(admin, (fn) => db.transaction(fn), () => sender);
    expect(sender.sent.at(-1)!.text).toContain("goes out through the postmark provider. If you can read this, it works.");
    await db.transaction((tx) => updateSettings(admin, tx, { email: { provider: "smtp", apiKey: "" } }));
  });

  test("only admins send an invite to an admin account", async () => {
    const { db } = get();
    await expect(db.transaction((tx) => createInvite(coordinator, tx, adminId))).rejects.toBeInstanceOf(ForbiddenError);
    await db.transaction((tx) => createInvite(admin, tx, adminId));
  });

  test("a settings group reports each bad field in plain words and saves nothing", async () => {
    const { db } = get();
    const r = await db.transaction((tx) =>
      saveGroup(coordinator, tx, GROUPS.billing, { ...Object.fromEntries(GROUPS.billing.fields.map((f) => [f.key, ""])), minimumBillableMinutes: "30", hourRoundingMinutes: "abc", agencyDefaultRateCents: "70.5", invoiceReviewMode: "all", invoiceSendSchedule: "immediate", invoiceSendDayOfWeek: "5", invoiceSendStartDate: "2026-01-02", invoiceSendDayOfMonth: "1", lateCancelPayBasis: "minimum", billingReplyToEmail: "not-an-email", "responseDays.vendor": "30", "responseDays.deputy": "30", "responseDays.coordinator": "7", lateVendorCancelHours: "24" }),
    );
    expect(r).toEqual({
      ok: false,
      error: "Check the highlighted fields. Nothing was saved.",
      fields: { minimumBillableMinutes: "Enter 24 or less.", hourRoundingMinutes: "Enter a whole number.", billingReplyToEmail: "Enter an email address, or leave it blank." },
    });
    expect((await db.transaction((tx) => getSettings(tx))).minimumBillableMinutes).toBe(240);
  });

  test("changing the release day moves unreleased details and says how many", async () => {
    const { db } = get();
    const p = agencyDateParts(new Date());
    const startAt = agencyInstant(p.year, p.month + 3, 10, 18, 0);
    const [v] = await db.insert(vendors).values({ name: "Release Vendor" }).returning();
    const [type] = await db.select().from(jobTypes).limit(1);
    const [job] = await db
      .insert(jobs)
      .values({ vendorId: v.id, typeId: type.id, title: "Release move", startAt, endAt: new Date(startAt.getTime() + 4 * 3_600_000), rateCents: 6500, state: "active", releaseAt: releaseAt(startAt, { releaseDayOfMonth: 15, releaseTime: "16:00" }) })
      .returning();
    const r = await db.transaction((tx) => saveGroup(coordinator, tx, GROUPS.release, { releaseDayOfMonth: "20", releaseTime: "16:00" }));
    expect(r).toEqual({ ok: true, message: "Saved. 1 detail now opens on the new release date." });
    const [after] = await db.select().from(jobs).where(eq(jobs.id, job.id));
    expect(agencyDateParts(after.releaseAt!).day).toBe(20);
    expect(await db.transaction((tx) => saveGroup(coordinator, tx, GROUPS.release, { releaseDayOfMonth: "20", releaseTime: "16:00" }))).toEqual({ ok: true, message: "Release settings saved." });
  });

  test("security settings are admin only even through the shared save", async () => {
    const { db } = get();
    await expect(db.transaction((tx) => saveGroup(coordinator, tx, GROUPS.security, { "security.emailCodeMinutes": "20", "security.emailCodeAttempts": "5", "security.trustedDeviceDays": "30", "security.passwordMinLength": "12" }))).rejects.toBeInstanceOf(ForbiddenError);
    expect(await db.transaction((tx) => saveGroup(admin, tx, GROUPS.security, { "security.emailCodeMinutes": "20", "security.emailCodeAttempts": "5", "security.trustedDeviceDays": "30", "security.passwordMinLength": "12" }))).toEqual({ ok: true, message: "Security settings saved." });
  });

  test("the billing group shows rate range problems beside the fields", async () => {
    const { db } = get();
    const billing = (over: Record<string, string>) => ({
      ...Object.fromEntries(GROUPS.billing.fields.map((f) => [f.key, ""])),
      minimumBillableMinutes: "4",
      hourRoundingMinutes: "15",
      agencyDefaultRateCents: "65",
      invoiceReviewMode: "all",
      invoiceSendSchedule: "immediate",
      invoiceSendDayOfWeek: "5",
      invoiceSendStartDate: "2026-01-02",
      invoiceSendDayOfMonth: "1",
      lateCancelPayBasis: "minimum",
      "responseDays.vendor": "30",
      "responseDays.deputy": "30",
      "responseDays.coordinator": "7",
      lateVendorCancelHours: "24",
      ...over,
    });
    expect(await db.transaction((tx) => saveGroup(coordinator, tx, GROUPS.billing, billing({ rateMinCents: "90", rateMaxCents: "80" })))).toMatchObject({ ok: false, fields: { rateMaxCents: "The maximum must be at least the minimum." } });
    expect(await db.transaction((tx) => saveGroup(coordinator, tx, GROUPS.billing, billing({ rateMinCents: "70", rateMaxCents: "" })))).toMatchObject({
      ok: false,
      fields: { agencyDefaultRateCents: "The agency default rate of $65 is outside the range. Rate must be at least $70 an hour." },
    });
    expect(await db.transaction((tx) => saveGroup(coordinator, tx, GROUPS.billing, billing({ rateMinCents: "50", rateMaxCents: "95.50" })))).toEqual({ ok: true, message: "Billing settings saved." });
    const s = await db.transaction((tx) => getSettings(tx));
    expect([s.rateMinCents, s.rateMaxCents]).toEqual([5000, 9550]);
    await db.transaction((tx) => saveGroup(coordinator, tx, GROUPS.billing, billing({ rateMinCents: "", rateMaxCents: "" })));
  });

  test("the sign-up group saves the week start day as a number", async () => {
    const { db } = get();
    const before = await db.transaction((tx) => getSettings(tx));
    const values = { ...groupValues(GROUPS.signup, before), weekStartsOn: "1" };
    expect(await db.transaction((tx) => saveGroup(coordinator, tx, GROUPS.signup, values))).toEqual({ ok: true, message: "Sign-up settings saved." });
    expect((await db.transaction((tx) => getSettings(tx))).weekStartsOn).toBe(1);
    await db.transaction((tx) => saveGroup(coordinator, tx, GROUPS.signup, { ...values, weekStartsOn: String(before.weekStartsOn) }));
  });

  test("the billing group saves the invoice send schedule, its send day and the wait-for-all-deputies switch", async () => {
    const { db } = get();
    const values = {
      ...Object.fromEntries(GROUPS.billing.fields.map((f) => [f.key, ""])),
      minimumBillableMinutes: "4",
      hourRoundingMinutes: "15",
      agencyDefaultRateCents: "",
      invoiceReviewMode: "all",
      lateCancelPayBasis: "minimum",
      "responseDays.vendor": "30",
      "responseDays.deputy": "30",
      "responseDays.coordinator": "7",
      lateVendorCancelHours: "24",
      invoiceSendSchedule: "every_2_weeks",
      invoiceSendDayOfWeek: "3",
      invoiceSendStartDate: "2026-12-02",
      invoiceSendDayOfMonth: "31",
      waitForAllDeputies: false,
    };
    expect(await db.transaction((tx) => saveGroup(coordinator, tx, GROUPS.billing, { ...values, invoiceSendStartDate: "Dec 2" }))).toMatchObject({ ok: false, fields: { invoiceSendStartDate: "Enter a date." } });
    expect(await db.transaction((tx) => saveGroup(coordinator, tx, GROUPS.billing, values))).toEqual({ ok: true, message: "Billing settings saved." });
    const s = await db.transaction((tx) => getSettings(tx));
    expect([s.invoiceSendSchedule, s.invoiceSendDayOfWeek, s.invoiceSendStartDate, s.invoiceSendDayOfMonth, s.waitForAllDeputies]).toEqual(["every_2_weeks", 3, "2026-12-02", 31, false]);
    await db.transaction((tx) => saveGroup(coordinator, tx, GROUPS.billing, { ...values, invoiceSendSchedule: "immediate", waitForAllDeputies: true }));
  });

  test("coordinators cannot grant, revoke or decide special flags on an admin account", async () => {
    const { db } = get();
    const [motors] = await db.select().from(qualifications).where(eq(qualifications.name, "Motors"));
    await expect(db.transaction((tx) => grantQualification(coordinator, tx, adminId, motors.id))).rejects.toBeInstanceOf(ForbiddenError);
    await db.transaction((tx) => grantQualification(admin, tx, adminId, motors.id));
    await expect(db.transaction((tx) => revokeQualification(coordinator, tx, adminId, motors.id))).rejects.toBeInstanceOf(ForbiddenError);
    const [k9] = await db.select().from(qualifications).where(eq(qualifications.name, "K9"));
    const [req] = await db.insert(qualificationRequests).values({ userId: adminId, qualificationId: k9.id }).returning();
    await expect(db.transaction((tx) => decideQualificationRequest(coordinator, tx, req.id, { approve: true }))).rejects.toBeInstanceOf(ForbiddenError);
    await expect(db.transaction((tx) => decideQualificationRequest(coordinator, tx, req.id, { approve: false, reason: "No" }))).rejects.toBeInstanceOf(ForbiddenError);
    const o = await db.transaction((tx) => flagOverview(coordinator, tx));
    expect(o.requests.find((x) => x.id === req.id)?.canDecide).toBe(false);
    await db.transaction((tx) => decideQualificationRequest(admin, tx, req.id, { approve: true }));
    const holders = await db.transaction((tx) => flagRecord(coordinator, tx, k9.id));
    expect(holders.holders.find((h) => h.userId === adminId)?.canChange).toBe(false);
  });
});
