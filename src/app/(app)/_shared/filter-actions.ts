"use server";

import { redirect } from "next/navigation";
import { NO_FILTERS, saveViewFilters } from "@/domain/calendar/calendar";
import { act } from "../_personnel/result";
import { filterParams, filtersFromParams } from "./detail-filters";
import { formText } from "@/lib/form-text";

/** Only these pages take the filter panel (List, Calendar and Map); anything else goes to the Calendar. */
const PATHS = ["/calendar", "/jobs", "/map"];
const KEEP = ["view", "date"];

function target(form: FormData): { path: string; keep: URLSearchParams } {
  const raw = formText(form, "path");
  const path = PATHS.includes(raw) ? raw : "/calendar";
  const keep = new URLSearchParams();
  for (const k of KEEP) {
    const v = form.get(`keep_${k}`);
    if (typeof v === "string" && /^[a-z0-9-]{1,20}$/.test(v)) keep.set(k, v);
  }
  return { path, keep };
}

/** Apply: the person's own filters go in the address bar; "My details only" and, when asked, the filters are saved for them alone. */
export async function applyFiltersAction(form: FormData): Promise<void> {
  const params: Record<string, string[]> = {};
  for (const [k, v] of form.entries()) if (typeof v === "string") params[k] = [...(params[k] ?? []), v];
  const filters = filtersFromParams(params);
  const remember = form.get("remember") === "1";
  const personal = form.get("personal") === "1";
  const r = await act(async (actor, tx) => {
    await saveViewFilters(actor, tx, { mine: filters.mine, remember, filters, personal });
  });
  const { path, keep } = target(form);
  const q = filterParams(personal ? filters : { ...filters, openOnly: false, week: false, flex: false, workable: false, sort: "date" });
  for (const [k, v] of keep) q.set(k, v);
  if (!r.ok) q.set("filter_error", "1");
  redirect(`${path}?${q.toString()}`);
}

/** Reset: none of this view's filters, nothing remembered; filters this view does not show are left as they are. */
export async function resetFiltersAction(form: FormData): Promise<void> {
  const personal = form.get("personal") === "1";
  await act(async (actor, tx) => {
    await saveViewFilters(actor, tx, { mine: false, remember: false, filters: NO_FILTERS, personal });
  });
  const { path, keep } = target(form);
  const q = new URLSearchParams({ f: "1" });
  for (const [k, v] of keep) q.set(k, v);
  redirect(`${path}?${q.toString()}`);
}
