import { agencyDateOnly } from "@/domain/time/agency-time";
import type { Party } from "@/domain/billing/payments";

/**
 * The Payments page filters. They live in the address bar (a GET form), so Back keeps them and a link shares them.
 * Within Status any checked option matches; every other filter narrows.
 */
export const PAYMENT_STATUSES = ["vendor", "deputy", "coordinator", "overdue", "vendor_paid", "hold", "not_confirmed"] as const;
export type PaymentStatusFilter = (typeof PAYMENT_STATUSES)[number];

export const DAY_PRESETS = { "0-7": { min: 0, max: 7 }, "8-30": { min: 8, max: 30 }, "31-": { min: 31, max: null } } as const;
export type DayPreset = keyof typeof DAY_PRESETS | "custom" | "";

export type PaymentFilters = {
  statuses: PaymentStatusFilter[];
  daysPreset: DayPreset;
  days: { min: number | null; max: number | null };
  vendorIds: string[];
  deputyIds: string[];
  /** Agency days, YYYY-MM-DD, inclusive. */
  from: string | null;
  to: string | null;
  amountMin: number | null;
  amountMax: number | null;
  sent: "sent" | "unsent" | null;
};

/** What a filter is tested against: one invoice on the board, or one the deputy confirmed. */
export type PaymentFilterRow = {
  party: Party | null;
  overdue: boolean;
  vendorReportsPaid: boolean;
  vendorOnHold: boolean;
  /** Days waiting on the current step. */
  day: number;
  vendorId: string;
  payeeUserId: string;
  /** The invoice date: when it was sent, else when it was made. */
  issuedAt: Date;
  totalCents: number;
  sent: boolean;
};

type ParamValue = string | string[] | undefined;
type Params = Record<string, ParamValue>;

function asList(v: ParamValue): string[] {
  if (Array.isArray(v)) return v;
  return v ? [v] : [];
}
const many = (v: ParamValue): string[] => asList(v).map((x) => x.trim()).filter(Boolean);
const one = (v: ParamValue): string => (Array.isArray(v) ? (v[0] ?? "") : (v ?? "")).trim();

function wholeDays(s: string): number | null {
  return /^\d{1,4}$/.test(s) ? Number(s) : null;
}

function cents(s: string): number | null {
  const t = s.replace(/[$,\s]/g, "");
  if (!/^\d{1,7}(\.\d{1,2})?$/.test(t)) return null;
  const [whole, part = ""] = t.split(".");
  return Number(whole) * 100 + Number(part.padEnd(2, "0"));
}

const day = (s: string): string | null => (/^\d{4}-\d{2}-\d{2}$/.test(s) && agencyDateOnly(s) ? s : null);

export function parsePaymentFilters(sp: Params): PaymentFilters {
  const statuses = many(sp.status).filter((s): s is PaymentStatusFilter => (PAYMENT_STATUSES as readonly string[]).includes(s));
  const preset = one(sp.days);
  let daysPreset: DayPreset = "";
  let days: PaymentFilters["days"] = { min: null, max: null };
  if (preset in DAY_PRESETS) {
    daysPreset = preset as keyof typeof DAY_PRESETS;
    days = { ...DAY_PRESETS[daysPreset] };
  } else if (preset === "custom") {
    daysPreset = "custom";
    days = { min: wholeDays(one(sp.dmin)), max: wholeDays(one(sp.dmax)) };
  }
  const sent = one(sp.sent);
  return {
    statuses: [...new Set(statuses)],
    daysPreset,
    days,
    vendorIds: many(sp.vendor),
    deputyIds: many(sp.deputy),
    from: day(one(sp.from)),
    to: day(one(sp.to)),
    amountMin: cents(one(sp.amin)),
    amountMax: cents(one(sp.amax)),
    sent: sent === "sent" || sent === "unsent" ? sent : null,
  };
}

/** How many filters are on, for the phone's "Filters (n on)" button. */
export function activePaymentFilters(f: PaymentFilters): number {
  return [
    f.statuses.length > 0,
    f.days.min !== null || f.days.max !== null,
    f.vendorIds.length > 0,
    f.deputyIds.length > 0,
    f.from !== null || f.to !== null,
    f.amountMin !== null || f.amountMax !== null,
    f.sent !== null,
  ].filter(Boolean).length;
}

function statusMatches(r: PaymentFilterRow, s: PaymentStatusFilter): boolean {
  switch (s) {
    case "vendor":
    case "deputy":
    case "coordinator":
      return r.party === s;
    case "overdue":
      return r.overdue;
    case "vendor_paid":
      return r.vendorReportsPaid;
    case "hold":
      return r.vendorOnHold;
    case "not_confirmed":
      return false;
  }
}

/** The filters every list shares: vendor, deputy, invoice date and amount. */
function commonMatches(r: PaymentFilterRow, f: PaymentFilters): boolean {
  if (f.vendorIds.length && !f.vendorIds.includes(r.vendorId)) return false;
  if (f.deputyIds.length && !f.deputyIds.includes(r.payeeUserId)) return false;
  if (f.from && r.issuedAt < agencyDateOnly(f.from)!) return false;
  if (f.to && r.issuedAt > agencyDateOnly(f.to, "end")!) return false;
  if (f.amountMin !== null && r.totalCents < f.amountMin) return false;
  if (f.amountMax !== null && r.totalCents > f.amountMax) return false;
  return true;
}

/** An unpaid invoice (on the board, or approved and not sent). */
export function matchesBoardRow(r: PaymentFilterRow, f: PaymentFilters): boolean {
  const board = f.statuses.filter((s) => s !== "not_confirmed");
  // Only Vendor not confirmed chosen: that list alone.
  if (f.statuses.length && !board.length) return false;
  if (board.length && !board.some((s) => statusMatches(r, s))) return false;
  if (f.days.min !== null && r.day < f.days.min) return false;
  if (f.days.max !== null && r.day > f.days.max) return false;
  if (f.sent === "sent" && !r.sent) return false;
  if (f.sent === "unsent" && r.sent) return false;
  return commonMatches(r, f);
}

/** A paid invoice the deputy confirmed and the vendor never marked: listed only when Vendor not confirmed is chosen. */
export function matchesNotConfirmedRow(r: PaymentFilterRow, f: PaymentFilters): boolean {
  if (!f.statuses.includes("not_confirmed")) return false;
  if (f.sent === "unsent") return false;
  return commonMatches(r, f);
}

/** The Payments address with the same filters, opening one invoice beside the list (or none). */
export function paymentsHref(sp: Params, open?: string | null): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(sp)) if (k !== "open") for (const x of asList(v)) q.append(k, x);
  if (open) q.set("open", open);
  const text = q.toString();
  return text ? `/coordinate/payments?${text}` : "/coordinate/payments";
}
