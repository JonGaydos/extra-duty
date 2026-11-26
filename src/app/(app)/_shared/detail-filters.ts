import { CAL_STATUSES, JOB_SORTS, NO_FILTERS, sharedOnly, type CalStatus, type DetailFilters, type FilterPrefs } from "@/domain/calendar/calendar";

/** The shared Calendar and Details filters in the address bar, so a filtered view can be linked and reloaded. */

type Param = string | string[] | undefined;
type Params = Record<string, Param>;
const asList = (v: Param): string[] => {
  if (Array.isArray(v)) return v;
  return v ? [v] : [];
};
const many = (v: Param) => asList(v).flatMap((x) => x.split(",")).filter(Boolean).slice(0, 500);
const one = (v: Param) => (Array.isArray(v) ? v[0] : v) ?? "";

const KEYS = ["vendor", "vtype", "type", "loc", "status", "person", "num", "q", "mine", "open", "week", "flex", "workable", "sort"] as const;

export function filtersFromParams(p: Params): DetailFilters {
  const num = /^#?(\d{1,9})$/.exec(one(p.num).trim());
  return {
    vendorIds: many(p.vendor),
    vendorTypeIds: many(p.vtype),
    typeIds: many(p.type),
    locationIds: many(p.loc),
    statuses: many(p.status).filter((s): s is CalStatus => (CAL_STATUSES as readonly string[]).includes(s)),
    personId: one(p.person) || null,
    jobNumber: num ? Number(num[1]) : null,
    q: one(p.q).slice(0, 100),
    mine: one(p.mine) === "1",
    openOnly: one(p.open) === "1",
    week: one(p.week) === "1",
    flex: one(p.flex) === "1",
    workable: one(p.workable) === "1",
    sort: (JOB_SORTS as readonly string[]).includes(one(p.sort)) ? (one(p.sort) as DetailFilters["sort"]) : "date",
  };
}

/**
 * The filters a view shows: the address bar's when it carries any (or `f=1`, an explicit choice such as Reset),
 * else the person's remembered filters, else none; "My details only" falls back to the person's last choice. A
 * view without the deputy-only filters (`personal` false) never applies or counts them.
 */
export function resolveFilters(p: Params, prefs: FilterPrefs, view: { personal: boolean }): DetailFilters {
  const explicit = one(p.f) === "1" || KEYS.some((k) => p[k] !== undefined && one(p[k]) !== "");
  let f: DetailFilters;
  if (explicit) f = filtersFromParams(p);
  else f = { ...(prefs.remember && prefs.filters ? prefs.filters : { ...NO_FILTERS, mine: prefs.mine }), ...(prefs.personal ?? {}) };
  return view.personal ? f : sharedOnly(f);
}

export function filterParams(f: DetailFilters): URLSearchParams {
  const q = new URLSearchParams();
  q.set("f", "1");
  if (f.vendorIds.length) q.set("vendor", f.vendorIds.join(","));
  if (f.vendorTypeIds.length) q.set("vtype", f.vendorTypeIds.join(","));
  if (f.typeIds.length) q.set("type", f.typeIds.join(","));
  if (f.locationIds.length) q.set("loc", f.locationIds.join(","));
  if (f.statuses.length) q.set("status", f.statuses.join(","));
  if (f.personId) q.set("person", f.personId);
  if (f.jobNumber !== null) q.set("num", String(f.jobNumber));
  if (f.q) q.set("q", f.q);
  if (f.mine) q.set("mine", "1");
  if (f.openOnly) q.set("open", "1");
  if (f.week) q.set("week", "1");
  if (f.flex) q.set("flex", "1");
  if (f.workable) q.set("workable", "1");
  if (f.sort !== "date") q.set("sort", f.sort);
  return q;
}

/** How many of the view's own filters are on, for the phone's Filters button. */
export function activeCount(f: DetailFilters, personal: boolean): number {
  if (!personal) f = sharedOnly(f);
  return [f.vendorIds.length, f.vendorTypeIds.length, f.typeIds.length, f.locationIds.length, f.statuses.length, f.personId ? 1 : 0, f.jobNumber !== null ? 1 : 0, f.q ? 1 : 0, f.mine ? 1 : 0, f.openOnly ? 1 : 0, f.week ? 1 : 0, f.flex ? 1 : 0, f.workable ? 1 : 0, f.sort !== "date" ? 1 : 0].filter((n) => n > 0).length;
}
