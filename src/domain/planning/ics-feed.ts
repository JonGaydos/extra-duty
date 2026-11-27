import { createHash, randomBytes } from "node:crypto";
import { and, asc, eq, gte, inArray, isNull } from "drizzle-orm";
import type { Tx } from "@/db/client";
import { assignments, calendarTokens, jobs, users, vendorLocations, vendors } from "@/db/schema";
import type { Actor } from "../actor";
import { recordAudit } from "../audit/audit";
import { assertOwn } from "./schedule";

const DAY_MS = 86_400_000;
/** Past details stay in the feed this long so a calendar app does not drop them the moment they start. */
const PAST_DAYS = 30;
const FEED_STATUSES = ["pending_short", "signed_up", "backup"] as const;

const hash = (token: string) => createHash("sha256").update(token).digest("hex");

export type CalendarTokenStatus = { active: boolean; createdAt: Date | null; lastUsedAt: Date | null };

async function liveToken(tx: Tx, userId: string) {
  const rows = await tx
    .select()
    .from(calendarTokens)
    .where(and(eq(calendarTokens.userId, userId), isNull(calendarTokens.revokedAt)));
  return rows.at(0) ?? null;
}

/** Whether the person has a live feed link. The token itself is never readable again. */
export async function calendarTokenStatus(actor: Actor, tx: Tx): Promise<CalendarTokenStatus> {
  assertOwn(actor);
  const row = await liveToken(tx, actor.userId);
  return { active: row !== null, createdAt: row?.createdAt ?? null, lastUsedAt: row?.lastUsedAt ?? null };
}

async function revokeLive(actor: Actor, tx: Tx, now: Date): Promise<boolean> {
  const ended = await tx
    .update(calendarTokens)
    .set({ revokedAt: now, updatedAt: now })
    .where(and(eq(calendarTokens.userId, actor.userId), isNull(calendarTokens.revokedAt)))
    .returning({ id: calendarTokens.id });
  return ended.length > 0;
}

/** Makes a new feed token (ending any earlier one) and returns it. Only its hash is stored. */
export async function rotateCalendarToken(actor: Actor, tx: Tx, now: Date = new Date()): Promise<string> {
  assertOwn(actor);
  await revokeLive(actor, tx, now);
  const token = randomBytes(32).toString("base64url");
  const [row] = await tx.insert(calendarTokens).values({ userId: actor.userId, tokenHash: hash(token), createdAt: now, updatedAt: now }).returning({ id: calendarTokens.id });
  await recordAudit(tx, { actor, action: "calendar_token.rotate", entityType: "calendar_token", entityId: row.id });
  return token;
}

/** Ends the person's feed link. Calendar apps subscribed to it stop updating. */
export async function revokeCalendarToken(actor: Actor, tx: Tx, now: Date = new Date()): Promise<void> {
  assertOwn(actor);
  const live = await liveToken(tx, actor.userId);
  if (!live || !(await revokeLive(actor, tx, now))) return;
  await recordAudit(tx, { actor, action: "calendar_token.revoke", entityType: "calendar_token", entityId: live.id });
}

/** RFC 5545 text escaping. */
function esc(v: string): string {
  return v.replaceAll("\\", "\\\\").replaceAll(";", "\\;").replaceAll(",", "\\,").replace(/\r?\n/g, "\\n");
}

/** Folds a content line at 75 octets. */
function fold(line: string): string {
  const bytes = Buffer.from(line, "utf8");
  if (bytes.length <= 75) return line;
  const parts: string[] = [];
  let current = "";
  for (const ch of line) {
    const limit = parts.length === 0 ? 75 : 74;
    if (Buffer.byteLength(current + ch, "utf8") > limit) {
      parts.push(current);
      current = ch;
    } else current += ch;
  }
  parts.push(current);
  return parts.join("\r\n ");
}

const stamp = (d: Date) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");

const LABEL: Record<(typeof FEED_STATUSES)[number], string> = {
  pending_short: "Pending shorter",
  signed_up: "Signed up",
  backup: "Backup",
};

/**
 * The .ics feed for a live token, or null. Lists only the token owner's own pending shorter, signed up and
 * backup details: vendor, title, their planned times and the location. Nothing about other people.
 */
export async function calendarFeedFor(tx: Tx, token: string, now: Date = new Date()): Promise<string | null> {
  if (typeof token !== "string" || token.length < 16 || token.length > 200) return null;
  const [row] = await tx
    .select()
    .from(calendarTokens)
    .where(and(eq(calendarTokens.tokenHash, hash(token)), isNull(calendarTokens.revokedAt)));
  if (!row) return null;
  // A deactivated account's feed stops even if a token was somehow left live.
  const [owner] = await tx.select({ active: users.active }).from(users).where(eq(users.id, row.userId));
  if (!owner?.active) return null;
  await tx.update(calendarTokens).set({ lastUsedAt: now }).where(eq(calendarTokens.id, row.id));

  const rows = await tx
    .select({
      status: assignments.status,
      plannedStartAt: assignments.plannedStartAt,
      plannedEndAt: assignments.plannedEndAt,
      backupPosition: assignments.backupPosition,
      job: { id: jobs.id, number: jobs.number, title: jobs.title, startAt: jobs.startAt, endAt: jobs.endAt, updatedAt: jobs.updatedAt },
      vendorName: vendors.name,
      locationName: vendorLocations.name,
      address: vendorLocations.address,
    })
    .from(assignments)
    .innerJoin(jobs, eq(jobs.id, assignments.jobId))
    .innerJoin(vendors, eq(vendors.id, jobs.vendorId))
    .leftJoin(vendorLocations, eq(vendorLocations.id, jobs.locationId))
    .where(
      and(
        eq(assignments.userId, row.userId),
        inArray(assignments.status, [...FEED_STATUSES]),
        gte(jobs.endAt, new Date(now.getTime() - PAST_DAYS * DAY_MS)),
      ),
    )
    .orderBy(asc(jobs.startAt));

  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Signal 90//Personal details//EN", "CALSCALE:GREGORIAN", "METHOD:PUBLISH", "X-WR-CALNAME:Signal 90"];
  for (const r of rows) {
    const status = r.status as (typeof FEED_STATUSES)[number];
    const label = status === "backup" && r.backupPosition ? `Backup #${r.backupPosition}` : LABEL[status];
    const where = [r.locationName, r.address].filter((v): v is string => Boolean(v?.trim())).join(", ");
    const suffix = status === "signed_up" ? "" : ` (${label})`;
    const summary = `${r.vendorName}: ${r.job.title}${suffix}`;
    const description = `Detail #${r.job.number}. ${label}.`;
    lines.push(
      "BEGIN:VEVENT",
      `UID:${r.job.id}@extra-duty`,
      `DTSTAMP:${stamp(now)}`,
      `LAST-MODIFIED:${stamp(r.job.updatedAt)}`,
      `DTSTART:${stamp(r.plannedStartAt ?? r.job.startAt)}`,
      `DTEND:${stamp(r.plannedEndAt ?? r.job.endAt)}`,
      `SUMMARY:${esc(summary)}`,
      `DESCRIPTION:${esc(description)}`,
      ...(where ? [`LOCATION:${esc(where)}`] : []),
      `STATUS:${status === "signed_up" ? "CONFIRMED" : "TENTATIVE"}`,
      "END:VEVENT",
    );
  }
  lines.push("END:VCALENDAR");
  return lines.map(fold).join("\r\n") + "\r\n";
}

/** Ends every live feed token of a person (used when the account is deactivated). Audited per token. */
export async function revokeCalendarTokensFor(tx: Tx, actor: Actor | "system", userId: string, now: Date = new Date()): Promise<number> {
  const ended = await tx
    .update(calendarTokens)
    .set({ revokedAt: now, updatedAt: now })
    .where(and(eq(calendarTokens.userId, userId), isNull(calendarTokens.revokedAt)))
    .returning({ id: calendarTokens.id });
  // Sequential: audit writes in this transaction.
  for (const t of ended) await recordAudit(tx, { actor, action: "calendar_token.revoke", entityType: "calendar_token", entityId: t.id, reason: "Account deactivated" });
  return ended.length;
}
