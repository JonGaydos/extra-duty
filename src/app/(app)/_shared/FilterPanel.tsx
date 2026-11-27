"use client";

import { useState } from "react";
import type { CalStatus, DetailFilters, FilterOptions } from "@/domain/calendar/calendar";
import { Button } from "@/ui/components/Button";
import { Card } from "@/ui/components/Card";
import { FormField, Input, Select } from "@/ui/components/FormField";
import { Icon } from "@/ui/icons";
import { applyFiltersAction, resetFiltersAction } from "./filter-actions";

const STATUS_TEXT: Record<CalStatus, string> = {
  open: "Open",
  filled: "Filled",
  not_released: "Not released",
  past: "Past",
  canceled: "Canceled",
  requested: "Vendor requests",
};

const box = "size-4.5 shrink-0 accent-accent";

function Group({ legend, name, options, picked }: Readonly<{ legend: string; name: string; options: Array<{ id: string; name: string }>; picked: string[] }>) {
  if (options.length === 0) return null;
  const n = picked.length;
  return (
    <details className="group rounded-md border border-line" open={n > 0}>
      <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-2 px-3 text-sm font-medium [&::-webkit-details-marker]:hidden">
        <span>
          {legend}
          {n ? <span className="text-muted"> ({n})</span> : null}
        </span>
        <Icon name="chevronRight" size={16} className="transition-transform group-open:rotate-90" />
      </summary>
      <fieldset className="m-0 flex max-h-56 flex-col overflow-y-auto border-0 border-t border-divider px-3 py-1">
        <legend className="sr-only">{legend}</legend>
        {options.map((o) => (
          <label key={o.id} className="flex min-h-10 items-center gap-2 text-sm pointer-coarse:min-h-11">
            <input type="checkbox" name={name} value={o.id} defaultChecked={picked.includes(o.id)} className={box} />
            <span className="min-w-0 break-words">{o.name}</span>
          </label>
        ))}
      </fieldset>
    </details>
  );
}

const SORTS: Array<[DetailFilters["sort"], string]> = [
  ["date", "Date"],
  ["total_pay", "Total pay"],
  ["rate", "Rate"],
  ["vendor", "Vendor"],
];

/**
 * The one filter panel for the Details List, Calendar and Map: a left column on desktop, a Filters sheet on phones.
 * Every view shows the same filters and they travel in the address between views; Sort by applies to the List only.
 * Apply and Reset change only the viewer's own view; Remember keeps one set for them alone, for every view.
 */
export function FilterPanel({ path, keep, filters, options, remember, active, staff, scheduleNote, sort = false }: Readonly<{ path: string; keep: Record<string, string>; filters: DetailFilters; options: FilterOptions; remember: boolean; active: number; staff: boolean; scheduleNote: string; sort?: boolean }>) {
  const [open, setOpen] = useState(false);
  return (
    <aside aria-label="Filters" className="flex flex-col gap-2">
      <div className="md:hidden">
        <Button variant="secondary" onClick={() => setOpen(!open)} aria-expanded={open} aria-controls="filter-panel" full>
          <Icon name="sliders" size={18} />
          {active ? `Filters (${active} on)` : "Filters"}
        </Button>
      </div>
      <div id="filter-panel" className={open ? "block" : "hidden md:block"}>
        <Card as="div">
          <form action={applyFiltersAction} className="flex flex-col gap-3">
            <h2 className="m-0 text-title font-semibold md:text-base">Filters</h2>
            <input type="hidden" name="path" value={path} />
            <input type="hidden" name="personal" value="1" />
            {Object.entries(keep).map(([k, v]) => (
              <input key={k} type="hidden" name={`keep_${k}`} value={v} />
            ))}
            <FormField label="Search">
              <Input name="q" defaultValue={filters.q} placeholder="Title, vendor or place" maxLength={100} />
            </FormField>
            <FormField label="Detail number">
              <Input name="num" defaultValue={filters.jobNumber ?? ""} inputMode="numeric" placeholder="1234" />
            </FormField>
            <label className="flex min-h-11 items-center gap-2 text-sm font-medium">
              <input type="checkbox" name="mine" value="1" defaultChecked={filters.mine} className={box} />My details only
            </label>
            <fieldset className="m-0 flex flex-col border-0 p-0">
              <legend className="mb-1 text-sm font-medium text-muted">For you</legend>
              <label className="flex min-h-10 items-center gap-2 text-sm pointer-coarse:min-h-11">
                <input type="checkbox" name="open" value="1" defaultChecked={filters.openOnly} className={box} />Open spots only
              </label>
              <label className="flex min-h-10 items-center gap-2 text-sm pointer-coarse:min-h-11">
                <input type="checkbox" name="week" value="1" defaultChecked={filters.week} className={box} />This week
              </label>
              <label className="flex min-h-10 items-center gap-2 text-sm pointer-coarse:min-h-11">
                <input type="checkbox" name="flex" value="1" defaultChecked={filters.flex} className={box} />Flexible times
              </label>
              <label className="flex min-h-10 items-start gap-2 py-1.5 text-sm pointer-coarse:min-h-11">
                <input type="checkbox" name="workable" value="1" defaultChecked={filters.workable} className={`${box} mt-0.5`} />
                <span className="flex flex-col">
                  Only details I can work<span className="text-xs text-muted">{scheduleNote}</span>
                </span>
              </label>
              </fieldset>
            {sort ? (
              <FormField label="Sort by">
                <Select name="sort" defaultValue={filters.sort}>
                  {SORTS.map(([v, label]) => (
                    <option key={v} value={v}>
                      {label}
                    </option>
                  ))}
                </Select>
              </FormField>
            ) : (
              // Sort by belongs to the List; the other views keep it for when the person goes back there.
              <input type="hidden" name="sort" value={filters.sort} />
            )}
            <fieldset className="m-0 flex flex-col border-0 p-0">
              <legend className="mb-1 text-sm font-medium text-muted">Status</legend>
              <div className="grid grid-cols-2 gap-x-2">
                {options.statuses.map((s) => (
                  <label key={s} className="flex min-h-10 items-center gap-2 text-sm pointer-coarse:min-h-11">
                    <input type="checkbox" name="status" value={s} defaultChecked={filters.statuses.includes(s)} className={box} />
                    {STATUS_TEXT[s]}
                  </label>
                ))}
              </div>
            </fieldset>
            <Group legend="Vendor" name="vendor" options={options.vendors} picked={filters.vendorIds} />
            <Group legend="Vendor type" name="vtype" options={options.vendorTypes} picked={filters.vendorTypeIds} />
            <Group legend="Detail type" name="type" options={options.types} picked={filters.typeIds} />
            <Group legend="Location" name="loc" options={options.locations} picked={filters.locationIds} />
            {options.people.length ? (
              <FormField label="Person signed up" hint={staff ? undefined : "People on rosters you can see."}>
                <Select name="person" defaultValue={filters.personId ?? ""}>
                  <option value="">Anyone</option>
                  {options.people.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </Select>
              </FormField>
            ) : null}
            <label className="flex min-h-11 items-center gap-2 text-sm">
              <input type="checkbox" name="remember" value="1" defaultChecked={remember} className={box} />Remember my filters
            </label>
            <div className="flex flex-wrap gap-2">
              <Button type="submit">Apply</Button>
              <Button type="submit" variant="secondary" formAction={resetFiltersAction}>
                Reset
              </Button>
            </div>
            <p className="m-0 text-xs text-muted">Filters change only your own view.</p>
          </form>
        </Card>
      </div>
    </aside>
  );
}
