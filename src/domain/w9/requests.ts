import { and, asc, desc, eq, gte, inArray, isNull, lt, ne } from "drizzle-orm";
import type { Tx } from "@/db/client";
import { qualifications, ranks, userQualifications, users, w9RequestPeople, w9Requests, w9s, type W9RequestAudience } from "@/db/schema";
import type { Actor } from "../actor";
import { recordAudit } from "../audit/audit";
import { assertCan } from "../auth/policy";
import { NotFoundError, ValidationError } from "../errors";
import { emit } from "../notifications/notify";
import { agencyDateOnly, agencyDayKey } from "../time/agency-time";
import { approvedW9, currentW9, dayText } from "./w9";

export type W9Request = typeof w9Requests.$inferSelect;
export type W9RequestInput = { audience: W9RequestAudience; dueOn: string; note?: string | null };

const MAX_NOTE = 500;
const DAY_MS = 86_400_000;

/** Active people who work details (not vendors) the audience names, with its label. */
async function audiencePeople(tx: Tx, a: W9RequestAudience): Promise<{ ids: string[]; label: string }> {
  const live = and(eq(users.active, true), ne(users.role, "vendor"));
  switch (a?.kind) {
    case "everyone":
      return { ids: (await tx.select({ id: users.id }).from(users).where(live)).map((r) => r.id), label: "Everyone" };
    case "users": {
      const ids = Array.isArray(a.userIds) ? a.userIds.filter((x): x is string => typeof x === "string") : [];
      const rows = ids.length ? await tx.select({ id: users.id, name: users.name }).from(users).where(and(live, inArray(users.id, ids))) : [];
      if (rows.length !== new Set(ids).size || rows.length === 0) throw new ValidationError("Choose active people who work details.");
      return { ids: rows.map((r) => r.id), label: rows.map((r) => r.name).sort((a, b) => a.localeCompare(b)).join(", ") };
    }
    case "rank": {
      const [rank] = typeof a.rankId === "string" ? await tx.select().from(ranks).where(eq(ranks.id, a.rankId)) : [];
      if (!rank) throw new NotFoundError("Rank not found.");
      return { ids: (await tx.select({ id: users.id }).from(users).where(and(live, eq(users.rankId, rank.id)))).map((r) => r.id), label: `Rank: ${rank.name}` };
    }
    case "flag": {
      const [flag] = typeof a.qualificationId === "string" ? await tx.select().from(qualifications).where(eq(qualifications.id, a.qualificationId)) : [];
      if (!flag) throw new NotFoundError("Special flag not found.");
      const rows = await tx
        .select({ id: users.id })
        .from(userQualifications)
        .innerJoin(users, eq(users.id, userQualifications.userId))
        .where(and(live, eq(userQualifications.qualificationId, flag.id), isNull(userQualifications.revokedAt)));
      return { ids: [...new Set(rows.map((r) => r.id))], label: `Flag: ${flag.name}` };
    }
    default:
      throw new ValidationError("Choose who to ask: one person, a rank, a special flag or everyone.");
  }
}

/**
 * Asks people for a new W-9 by a due date (an agency date after today), with an optional note such as "New IRS
 * revision". The people asked are fixed now; each is told in the app (and by email or push per the notification
 * settings). After the due date, anyone asked without a W-9 uploaded since and approved is sign-up locked.
 */
export async function createW9Request(actor: Actor, tx: Tx, input: W9RequestInput, now: Date = new Date()): Promise<W9Request> {
  assertCan(actor, "w9.review");
  const dueOn = typeof input.dueOn === "string" ? input.dueOn.trim() : "";
  if (!agencyDateOnly(dueOn)) throw new ValidationError("Choose the date the new W-9 is due.");
  if (dueOn <= agencyDayKey(now)) throw new ValidationError("The due date must be after today.");
  const note = typeof input.note === "string" && input.note.trim() ? input.note.trim() : null;
  if (note && note.length > MAX_NOTE) throw new ValidationError(`The note can be at most ${MAX_NOTE} characters.`);
  const { ids, label } = await audiencePeople(tx, input.audience);
  if (ids.length === 0) throw new ValidationError("No active people match. Choose someone else.");

  const [row] = await tx.insert(w9Requests).values({ requestedBy: actor.userId, requestedAt: now, audience: input.audience, audienceLabel: label, dueOn, note }).returning();
  await tx.insert(w9RequestPeople).values(ids.map((userId) => ({ requestId: row.id, userId })));
  await recordAudit(tx, { actor, action: "w9.request", entityType: "w9_request", entityId: row.id, after: { audience: label, people: ids.length, dueOn, note } });
  await emit(
    tx,
    {
      type: "w9.renewal_requested",
      recipients: ids,
      title: "New W-9 requested",
      body: [`Upload a new W-9 by ${dayText(dueOn)}.`, note ? `${note}.` : "", "After that you cannot sign up for details until it is approved."].filter(Boolean).join(" "),
      link: "/profile#w9",
    },
    now,
  );
  return row;
}

export type RequestPersonStatus = "done" | "pending" | "rejected" | "missing";
export type RequestPerson = { userId: string; name: string; status: RequestPersonStatus };
export type W9RequestSummary = W9Request & { requestedByName: string; counts: Record<RequestPersonStatus, number>; total: number; overdue: boolean };

/** Where one person stands on a request, from their uploads since it was made. */
export function personStatus(uploads: Array<Pick<typeof w9s.$inferSelect, "status" | "uploadedAt">>, requestedAt: Date): RequestPersonStatus {
  const since = uploads.filter((u) => u.uploadedAt.getTime() >= requestedAt.getTime()).sort((a, b) => b.uploadedAt.getTime() - a.uploadedAt.getTime());
  if (since.some((u) => u.status === "approved")) return "done";
  if (since.length === 0) return "missing";
  return since[0].status === "pending" ? "pending" : "rejected";
}

/** Each person asked by these requests, with where they stand. */
async function peopleOf(tx: Tx, requests: W9Request[]): Promise<Map<string, RequestPerson[]>> {
  const out = new Map<string, RequestPerson[]>();
  if (requests.length === 0) return out;
  const rows = await tx
    .select({ requestId: w9RequestPeople.requestId, userId: w9RequestPeople.userId, name: users.name })
    .from(w9RequestPeople)
    .innerJoin(users, eq(users.id, w9RequestPeople.userId))
    .where(inArray(w9RequestPeople.requestId, requests.map((r) => r.id)))
    .orderBy(asc(users.name));
  const userIds = [...new Set(rows.map((r) => r.userId))];
  const uploads = userIds.length ? await tx.select({ userId: w9s.userId, status: w9s.status, uploadedAt: w9s.uploadedAt }).from(w9s).where(inArray(w9s.userId, userIds)) : [];
  const byUser = new Map<string, typeof uploads>();
  for (const u of uploads) byUser.set(u.userId, [...(byUser.get(u.userId) ?? []), u]);
  const at = new Map(requests.map((r) => [r.id, r.requestedAt]));
  for (const r of rows) {
    const list = out.get(r.requestId) ?? [];
    list.push({ userId: r.userId, name: r.name, status: personStatus(byUser.get(r.userId) ?? [], at.get(r.requestId)!) });
    out.set(r.requestId, list);
  }
  return out;
}

/** Every request, newest first, with its counts: done, pending review, rejected and missing. Staff only. */
export async function listW9Requests(actor: Actor, tx: Tx, now: Date = new Date()): Promise<W9RequestSummary[]> {
  assertCan(actor, "w9.review");
  const rows = await tx
    .select({ r: w9Requests, requestedByName: users.name })
    .from(w9Requests)
    .innerJoin(users, eq(users.id, w9Requests.requestedBy))
    .orderBy(desc(w9Requests.requestedAt), desc(w9Requests.id));
  const people = await peopleOf(tx, rows.map((x) => x.r));
  const today = agencyDayKey(now);
  return rows.map(({ r, requestedByName }) => {
    const list = people.get(r.id) ?? [];
    const counts = { done: 0, pending: 0, rejected: 0, missing: 0 };
    for (const p of list) counts[p.status]++;
    return { ...r, requestedByName, counts, total: list.length, overdue: r.dueOn < today };
  });
}

/** One request with each person asked and their status. Staff only. */
export async function w9RequestDetail(actor: Actor, tx: Tx, requestId: string): Promise<{ request: W9Request; people: RequestPerson[] }> {
  assertCan(actor, "w9.review");
  const [request] = typeof requestId === "string" ? await tx.select().from(w9Requests).where(eq(w9Requests.id, requestId)) : [];
  if (!request) throw new NotFoundError("W-9 request not found.");
  return { request, people: (await peopleOf(tx, [request])).get(request.id) ?? [] };
}

/** The earliest request past its due date that this person has not met, or null. */
export async function overdueW9Request(tx: Tx, userId: string, now: Date): Promise<W9Request | null> {
  const asked = await tx
    .select({ r: w9Requests })
    .from(w9RequestPeople)
    .innerJoin(w9Requests, eq(w9Requests.id, w9RequestPeople.requestId))
    .where(and(eq(w9RequestPeople.userId, userId), lt(w9Requests.dueOn, agencyDayKey(now))))
    .orderBy(asc(w9Requests.dueOn), asc(w9Requests.id));
  if (asked.length === 0) return null;
  const uploads = await tx.select({ status: w9s.status, uploadedAt: w9s.uploadedAt }).from(w9s).where(eq(w9s.userId, userId));
  return asked.find(({ r }) => personStatus(uploads, r.requestedAt) !== "done")?.r ?? null;
}

/** Open requests this person still has to meet (due today or later), soonest first: shown on their Profile. */
export async function openW9RequestsFor(tx: Tx, userId: string, now: Date): Promise<W9Request[]> {
  const asked = await tx
    .select({ r: w9Requests })
    .from(w9RequestPeople)
    .innerJoin(w9Requests, eq(w9Requests.id, w9RequestPeople.requestId))
    .where(and(eq(w9RequestPeople.userId, userId), gte(w9Requests.dueOn, agencyDayKey(now))))
    .orderBy(asc(w9Requests.dueOn), asc(w9Requests.id));
  if (asked.length === 0) return [];
  const uploads = await tx.select({ status: w9s.status, uploadedAt: w9s.uploadedAt }).from(w9s).where(eq(w9s.userId, userId));
  return asked.filter(({ r }) => personStatus(uploads, r.requestedAt) !== "done").map(({ r }) => r);
}

/** Whole agency days from today to the due date. */
function daysLeft(dueOn: string, now: Date): number {
  return Math.round((Date.parse(`${dueOn}T12:00:00Z`) - Date.parse(`${agencyDayKey(now)}T12:00:00Z`)) / DAY_MS);
}

/**
 * Daily: reminds each person asked who has not met a request yet, a week before the due date and the day before.
 * Each reminder goes once (the person's reminder stage). Returns how many reminders went out.
 */
export async function w9RenewalRemindersTick(tx: Tx, now: Date): Promise<number> {
  const open = await tx
    .select({ p: w9RequestPeople, r: w9Requests })
    .from(w9RequestPeople)
    .innerJoin(w9Requests, eq(w9Requests.id, w9RequestPeople.requestId))
    .innerJoin(users, eq(users.id, w9RequestPeople.userId))
    .where(and(gte(w9Requests.dueOn, agencyDayKey(now)), lt(w9RequestPeople.reminderStage, 2), eq(users.active, true)))
    .orderBy(asc(w9RequestPeople.id));
  let sent = 0;
  // Sequential: reads, updates and notifications in this transaction.
  for (const { p, r } of open) {
    const left = daysLeft(r.dueOn, now);
    let stage = p.reminderStage;
    if (left <= 1) stage = 2;
    else if (left <= 7) stage = Math.max(stage, 1);
    if (stage === p.reminderStage) continue;
    const uploads = await tx.select({ status: w9s.status, uploadedAt: w9s.uploadedAt }).from(w9s).where(eq(w9s.userId, p.userId));
    await tx.update(w9RequestPeople).set({ reminderStage: stage }).where(eq(w9RequestPeople.id, p.id));
    if (personStatus(uploads, r.requestedAt) !== "missing" && personStatus(uploads, r.requestedAt) !== "rejected") continue;
    await emit(
      tx,
      {
        type: "w9.renewal_reminder",
        recipients: [p.userId],
        title: "New W-9 due soon",
        body: `Your new W-9 is due ${dayText(r.dueOn)}. Upload it in Profile. After that date you cannot sign up until it is approved.`,
        link: "/profile#w9",
      },
      now,
    );
    sent++;
  }
  return sent;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "2027-01-31" as "Jan 31", with the year only when it is not this year's. */
function shortDay(key: string, now: Date = new Date()): string {
  const [y, m, d] = key.split("-").map(Number);
  return y === Number(agencyDayKey(now).slice(0, 4)) ? `${MONTHS[m - 1]} ${d}` : `${MONTHS[m - 1]} ${d}, ${y}`;
}

export type W9Lock = { locked: boolean; message: string };

/**
 * The W-9 sign-up lock (owner decision 2026-11-27): without an approved W-9 a person cannot sign up. It locks sign-ups
 * only; they can still sign in, see details, bill finished work and be paid, and coordinators can still assign them
 * with an override reason. After a renewal request's due date, a person asked who has no W-9 uploaded since the
 * request and approved is locked too.
 */
export async function readW9Lock(tx: Tx, userId: string, now: Date): Promise<W9Lock> {
  if (await approvedW9(tx, userId)) {
    const overdue = await overdueW9Request(tx, userId, now);
    return overdue ? { locked: true, message: `A new W-9 was due ${shortDay(overdue.dueOn, now)}` } : { locked: false, message: "" };
  }
  const latest = await currentW9(tx, userId);
  if (latest?.status === "rejected") return { locked: true, message: "Your W-9 was not approved. Upload a new one in Profile to sign up" };
  if (latest?.status === "pending") return { locked: true, message: "Your W-9 needs to be approved before you can sign up" };
  return { locked: true, message: "Your W-9 needs to be approved before you can sign up. Upload it in Profile" };
}
