import { beforeAll, describe, expect, test } from "vitest";
import { createHash } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { useTestDb } from "../../setup/test-db";
import { useEmailQueue } from "../../setup/email-queue";
import { setupFixture } from "../assignments/helpers";
import { auditLog, calendarTokens, users, vendorLocations, jobs } from "@/db/schema";
import { deactivateUser } from "@/domain/users/users";
import type { Actor } from "@/domain/actor";
import { joinBackup, signUp } from "@/domain/assignments/signup";
import { cancelSignup } from "@/domain/assignments/cancel";
import { ForbiddenError } from "@/domain/errors";
import { calendarFeedFor, calendarTokenStatus, revokeCalendarToken, rotateCalendarToken } from "@/domain/planning/ics-feed";

const NOW = new Date("2035-01-01T12:00:00Z");

describe("personal calendar feed", () => {
  const get = useTestDb();
  useEmailQueue(get);
  let f: Awaited<ReturnType<typeof setupFixture>>;
  let me: Actor;
  let other: Actor;
  let signedJob: string;
  let backupJob: string;
  let canceledJob: string;
  let othersJob: string;

  beforeAll(async () => {
    f = await setupFixture(get().db, "ics");
    me = await f.person();
    other = await f.person();
    const [loc] = await get().db.insert(vendorLocations).values({ vendorId: f.vendorId, name: "Main gate", address: "100 Example St, Pine Harbor, FL" }).returning();
    const a = await f.mkJob();
    await get().db.update(jobs).set({ locationId: loc.id, title: "Stadium; gate, east" }).where(eq(jobs.id, a.job.id));
    await f.run((tx) => signUp(me, tx, a.positionId, { warningVersion: 1, now: NOW }));
    signedJob = a.job.id;

    const full = await f.mkJob();
    await f.run((tx) => signUp(other, tx, full.positionId, { warningVersion: 1, now: NOW }));
    await f.run((tx) => joinBackup(me, tx, full.positionId, { warningVersion: 1, now: NOW }));
    backupJob = full.job.id;
    othersJob = full.job.id;

    const c = await f.mkJob();
    const mine = await f.run((tx) => signUp(me, tx, c.positionId, { warningVersion: 1, now: NOW }));
    await f.run((tx) => cancelSignup(me, tx, mine.id, "Court date", NOW));
    canceledJob = c.job.id;
  });

  test("a new token is returned once and stored only as a hash", async () => {
    const token = await f.run((tx) => rotateCalendarToken(me, tx, NOW));
    expect(token).toMatch(/^[A-Za-z0-9_-]{32,}$/);
    const rows = await get().db.select().from(calendarTokens).where(eq(calendarTokens.userId, me.userId));
    expect(rows).toHaveLength(1);
    expect(rows[0].tokenHash).toBe(createHash("sha256").update(token).digest("hex"));
    expect(JSON.stringify(rows)).not.toContain(token);
    const status = await f.run((tx) => calendarTokenStatus(me, tx));
    expect(status.active).toBe(true);
    const audits = await get().db.select().from(auditLog).where(eq(auditLog.action, "calendar_token.rotate"));
    expect(JSON.stringify(audits)).not.toContain(token);
  });

  test("the feed lists only the person's own sign-ups and backups, with vendor, times and location", async () => {
    const token = await f.run((tx) => rotateCalendarToken(me, tx, NOW));
    const ics = await f.run((tx) => calendarFeedFor(tx, token, NOW));
    expect(ics).not.toBeNull();
    const text = ics!;
    expect(text).toMatch(/^BEGIN:VCALENDAR\r\n/);
    expect(text).toContain("END:VCALENDAR");
    const events = text.split("BEGIN:VEVENT").length - 1;
    expect(events).toBe(2);
    expect(text).toContain(`UID:${signedJob}`);
    expect(text).toContain(`UID:${backupJob}`);
    expect(text).not.toContain(canceledJob);
    expect(text).toContain("ics Vendor");
    expect(text).toContain("Stadium\\; gate\\, east");
    expect(text).toContain("LOCATION:Main gate\\, 100 Example St\\, Pine Harbor\\, FL");
    expect(text).toContain("Backup");
    expect(text).toMatch(/DTSTART:\d{8}T\d{6}Z/);
    // A signed-up event has no status in its summary; a backup names its place in line.
    const lines = text.replace(/\r\n /g, "").split("\r\n");
    expect(lines.filter((l) => l.startsWith("SUMMARY:") || l.startsWith("DESCRIPTION:") || l.startsWith("STATUS:"))).toEqual([
      "SUMMARY:ics Vendor: Stadium\\; gate\\, east",
      "DESCRIPTION:Job #1. Signed up.",
      "STATUS:CONFIRMED",
      "SUMMARY:ics Vendor: Stadium security (Backup #1)",
      "DESCRIPTION:Job #2. Backup #1.",
      "STATUS:TENTATIVE",
    ]);
    // No other person's data.
    const otherUser = await get().db.query.users.findFirst({ where: (u, { eq }) => eq(u.id, other.userId) });
    expect(text).not.toContain(otherUser!.name);
    expect(othersJob).toBe(backupJob);
  });

  test("rotating ends the old token and revoking ends the feed", async () => {
    const first = await f.run((tx) => rotateCalendarToken(me, tx, NOW));
    const second = await f.run((tx) => rotateCalendarToken(me, tx, NOW));
    expect(await f.run((tx) => calendarFeedFor(tx, first, NOW))).toBeNull();
    expect(await f.run((tx) => calendarFeedFor(tx, second, NOW))).not.toBeNull();
    await f.run((tx) => revokeCalendarToken(me, tx, NOW));
    expect(await f.run((tx) => calendarFeedFor(tx, second, NOW))).toBeNull();
    expect((await f.run((tx) => calendarTokenStatus(me, tx))).active).toBe(false);
    expect(await f.run((tx) => calendarFeedFor(tx, "not-a-token", NOW))).toBeNull();
  });

  test("vendors cannot have a feed", async () => {
    const vendorActor: Actor = { userId: me.userId, role: "vendor", rankId: null, vendorId: f.vendorId };
    await expect(f.run((tx) => rotateCalendarToken(vendorActor, tx, NOW))).rejects.toBeInstanceOf(ForbiddenError);
  });

  test("deactivating the account revokes the feed, and an inactive owner's token never serves", async () => {
    const token = await f.run((tx) => rotateCalendarToken(me, tx, NOW));
    expect(await f.run((tx) => calendarFeedFor(tx, token, NOW))).not.toBeNull();
    await get().db.update(users).set({ active: false }).where(eq(users.id, me.userId));
    expect(await f.run((tx) => calendarFeedFor(tx, token, NOW))).toBeNull();
    await get().db.update(users).set({ active: true }).where(eq(users.id, me.userId));
    expect(await f.run((tx) => calendarFeedFor(tx, token, NOW))).not.toBeNull();
    await f.run((tx) => deactivateUser(f.coord, tx, me.userId, { reason: "Left the agency", lastDay: "2026-01-02" }));
    const live = await get().db.select().from(calendarTokens).where(and(eq(calendarTokens.userId, me.userId), isNull(calendarTokens.revokedAt)));
    expect(live).toEqual([]);
    await get().db.update(users).set({ active: true }).where(eq(users.id, me.userId));
    expect(await f.run((tx) => calendarFeedFor(tx, token, NOW))).toBeNull();
  });
});
