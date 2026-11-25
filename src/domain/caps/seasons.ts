import { asc, eq } from "drizzle-orm";
import type { Tx } from "@/db/client";
import { seasons } from "@/db/schema";
import type { Actor } from "../actor";
import { recordAudit } from "../audit/audit";
import { assertCan } from "../auth/policy";
import { NotFoundError, RuleViolation, ValidationError } from "../errors";
import { agencyDateParts } from "../time/agency-time";

export type Season = typeof seasons.$inferSelect;

export type SeasonInput = {
  name: string;
  startMonthDay: string;
  endMonthDay: string;
  /** Null means the cap is not enforced. */
  rollingCapMinutes: number | null;
  weekCapMinutes: number | null;
  monthCapMinutes: number | null;
};

const DAYS_IN_MONTH = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/** `MM-DD` to a comparable number (month * 100 + day). Feb 29 is allowed. */
function monthDayValue(md: string): number {
  const m = /^(\d{2})-(\d{2})$/.exec(md);
  if (!m) throw new ValidationError("Dates must be written MM-DD.");
  const month = Number(m[1]);
  const day = Number(m[2]);
  if (month < 1 || month > 12 || day < 1 || day > DAYS_IN_MONTH[month - 1]) {
    throw new ValidationError(`${md} is not a valid date.`);
  }
  return month * 100 + day;
}

/** Day ranges covered by a season; a season that wraps the year end becomes two ranges. */
function ranges(startMonthDay: string, endMonthDay: string): [number, number][] {
  const s = monthDayValue(startMonthDay);
  const e = monthDayValue(endMonthDay);
  return s <= e
    ? [[s, e]]
    : [
        [s, 1231],
        [101, e],
      ];
}

function overlaps(a: Pick<Season, "startMonthDay" | "endMonthDay">, b: Pick<Season, "startMonthDay" | "endMonthDay">) {
  return ranges(a.startMonthDay, a.endMonthDay).some(([s1, e1]) =>
    ranges(b.startMonthDay, b.endMonthDay).some(([s2, e2]) => s1 <= e2 && s2 <= e1),
  );
}

/** The season covering the agency-time calendar day of `date`, or null (no caps apply). */
export function seasonFor(date: Date, all: Season[]): Season | null {
  const p = agencyDateParts(date);
  const v = p.month * 100 + p.day;
  return all.find((s) => ranges(s.startMonthDay, s.endMonthDay).some(([a, b]) => a <= v && v <= b)) ?? null;
}

function validate(input: SeasonInput): SeasonInput {
  const name = input.name.trim();
  if (!name) throw new ValidationError("Season name is required.");
  monthDayValue(input.startMonthDay);
  monthDayValue(input.endMonthDay);
  for (const cap of [input.rollingCapMinutes, input.weekCapMinutes, input.monthCapMinutes]) {
    if (cap !== null && (!Number.isInteger(cap) || cap <= 0)) {
      throw new ValidationError("Caps must be whole minutes greater than zero, or blank for no cap.");
    }
  }
  return { ...input, name };
}

async function assertNoOverlap(tx: Tx, candidate: SeasonInput, ignoreId?: string): Promise<void> {
  const others = (await tx.select().from(seasons)).filter((s) => s.id !== ignoreId);
  const clash = others.find((s) => overlaps(candidate, s));
  if (clash) {
    throw new RuleViolation([
      {
        check: "season.no_overlap",
        ok: false,
        message: `These dates overlap the season "${clash.name}".`,
      },
    ]);
  }
}

export async function listSeasons(actor: Actor, tx: Tx): Promise<Season[]> {
  assertCan(actor, "season.manage");
  return tx.select().from(seasons).orderBy(asc(seasons.startMonthDay));
}

export async function createSeason(actor: Actor, tx: Tx, input: SeasonInput): Promise<Season> {
  assertCan(actor, "season.manage");
  const v = validate(input);
  await assertNoOverlap(tx, v);
  const [row] = await tx.insert(seasons).values(v).returning();
  await recordAudit(tx, { actor, action: "season.create", entityType: "season", entityId: row.id, before: null, after: row });
  return row;
}

export async function updateSeason(actor: Actor, tx: Tx, id: string, input: SeasonInput): Promise<Season> {
  assertCan(actor, "season.manage");
  const [before] = await tx.select().from(seasons).where(eq(seasons.id, id));
  if (!before) throw new NotFoundError("Season not found.");
  const v = validate(input);
  await assertNoOverlap(tx, v, id);
  const [after] = await tx.update(seasons).set(v).where(eq(seasons.id, id)).returning();
  await recordAudit(tx, { actor, action: "season.update", entityType: "season", entityId: id, before, after });
  return after;
}

/** Seasons are configuration, so deletion is allowed. The audit row keeps the old values. */
export async function deleteSeason(actor: Actor, tx: Tx, id: string): Promise<void> {
  assertCan(actor, "season.manage");
  const [before] = await tx.select().from(seasons).where(eq(seasons.id, id));
  if (!before) throw new NotFoundError("Season not found.");
  await tx.delete(seasons).where(eq(seasons.id, id));
  await recordAudit(tx, { actor, action: "season.delete", entityType: "season", entityId: id, before, after: null });
}
