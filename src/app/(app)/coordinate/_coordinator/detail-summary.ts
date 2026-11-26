import { billableMinutes, invoiceTotal } from "@/domain/billing/rules";
import type { Cents, Minutes } from "@/domain/types";

/** What the new detail form and quick edit show as pay: worked out per date, per position. */

export type TimeOverride = { startTime?: string; endTime?: string };
export type SummaryPosition = { positionTypeId: string; count: number; differentialCents: Cents };
type Pay = { totalCents: Cents; rateCents: Cents };

const minutesOf = (t: string) => (/^\d{2}:\d{2}$/.test(t) ? Number(t.slice(0, 2)) * 60 + Number(t.slice(3)) : null);

/** Minutes from start to end on the clock; an end at or before the start ends the next day (equal is 24 hours). */
export function spanMinutes(start: string, end: string): Minutes | null {
  const a = minutesOf(start);
  const b = minutesOf(end);
  if (a === null || b === null) return null;
  return b > a ? b - a : b + 1440 - a;
}

export type DetailSummary = {
  /** Each date's own lowest and highest pay for one deputy (an Incident Commander spot pays the high end). */
  perDate: Array<{ date: string | null; minutes: Minutes | null; perDeputy: Pay[]; low: Pay | null; high: Pay | null }>;
  /** Lowest and highest one deputy earns across every date and position; null until the times are set. */
  low: Pay | null;
  high: Pay | null;
  vendorTotalCents: Cents | null;
};

export function detailSummary(input: {
  dates: string[];
  startTime: string;
  endTime: string;
  overrides: Record<string, TimeOverride>;
  rateCents: Cents;
  positions: SummaryPosition[];
  rules: { minimumBillableMinutes: number; hourRoundingMinutes: number };
}): DetailSummary {
  const dates: Array<string | null> = input.dates.length ? input.dates : [null];
  let low: Pay | null = null;
  let high: Pay | null = null;
  let total: Cents | null = 0;
  const perDate = dates.map((date) => {
    const o = date ? input.overrides[date] : undefined;
    const minutes = spanMinutes(o?.startTime ?? input.startTime, o?.endTime ?? input.endTime);
    if (minutes === null || input.rateCents <= 0) {
      total = null;
      return { date, minutes, perDeputy: [], low: null, high: null };
    }
    const billable = billableMinutes(minutes, input.rules);
    const perDeputy = input.positions.map((p) => {
      const rateCents = input.rateCents + p.differentialCents;
      const pay = { totalCents: invoiceTotal(billable, Math.max(0, rateCents)), rateCents };
      if (!low || pay.totalCents < low.totalCents) low = pay;
      if (!high || pay.totalCents > high.totalCents) high = pay;
      if (total !== null) total += pay.totalCents * (Number(p.count) || 0);
      return pay;
    });
    const byTotal = [...perDeputy].sort((a, b) => a.totalCents - b.totalCents);
    return { date, minutes, perDeputy, low: byTotal[0] ?? null, high: byTotal.at(-1) ?? null };
  });
  return { perDate, low, high, vendorTotalCents: total };
}

type Row = { positionTypeId: string; count: number };

/** Add position: the agency default type, or one more of it when it is already listed. */
export function addPosition<T extends Row>(rows: T[], defaultTypeId: string): T[] {
  const at = rows.findIndex((r) => r.positionTypeId === defaultTypeId);
  if (at >= 0) return rows.map((r, i) => (i === at ? { ...r, count: (Number(r.count) || 0) + 1 } : r));
  return [...rows, { positionTypeId: defaultTypeId, count: 1 } as T];
}

/** Changes one row's type; a type already listed elsewhere merges into that row with the counts added. */
export function changePositionType<T extends Row>(rows: T[], index: number, typeId: string): T[] {
  const other = rows.findIndex((r, i) => i !== index && r.positionTypeId === typeId);
  if (other < 0) return rows.map((r, i) => (i === index ? { ...r, positionTypeId: typeId } : r));
  const merged = rows.map((r, i) => (i === other ? { ...r, count: (Number(r.count) || 0) + (Number(rows[index].count) || 0) } : r));
  return merged.filter((_, i) => i !== index);
}
