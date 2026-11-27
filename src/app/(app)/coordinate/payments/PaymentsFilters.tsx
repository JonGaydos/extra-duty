"use client";

import { useState } from "react";
import type { PaymentFilters, PaymentStatusFilter } from "@/domain/coordinator/payment-filters";
import { ButtonLink, Button } from "@/ui/components/Button";
import { Card } from "@/ui/components/Card";
import { FormField, Input, Select } from "@/ui/components/FormField";
import { Icon } from "@/ui/icons";

const STATUS_TEXT: Record<PaymentStatusFilter, string> = {
  vendor: "Vendor's turn",
  deputy: "Deputy's turn",
  coordinator: "Coordinator's turn",
  overdue: "Overdue",
  vendor_paid: "Vendor reports paid",
  hold: "Vendor on hold",
  not_confirmed: "Vendor not confirmed",
};

const box = "size-4.5 shrink-0 accent-accent";

type Option = { id: string; name: string };

/** A collapsible checkbox list with a search box that narrows it; checked boxes stay in the form while hidden. */
function SearchGroup({ legend, name, options, picked }: Readonly<{ legend: string; name: string; options: Option[]; picked: string[] }>) {
  const [q, setQ] = useState("");
  if (options.length === 0) return null;
  const n = picked.length;
  const needle = q.trim().toLowerCase();
  const shown = options.filter((o) => !needle || o.name.toLowerCase().includes(needle)).length;
  return (
    <details className="group rounded-md border border-line" open={n > 0}>
      <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-2 px-3 text-sm font-medium [&::-webkit-details-marker]:hidden">
        <span>
          {legend}
          {n ? <span className="text-muted"> ({n})</span> : null}
        </span>
        <Icon name="chevronRight" size={16} className="transition-transform group-open:rotate-90" />
      </summary>
      <div className="border-t border-divider px-3 pt-2">
        <Input type="search" aria-label={`Search ${legend.toLowerCase()}`} placeholder={`Search ${legend.toLowerCase()}`} value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      <fieldset className="m-0 flex max-h-56 flex-col overflow-y-auto border-0 px-3 py-1">
        <legend className="sr-only">{legend}</legend>
        {options.map((o) => (
          <label key={o.id} hidden={Boolean(needle) && !o.name.toLowerCase().includes(needle)} className="flex min-h-10 items-center gap-2 text-sm pointer-coarse:min-h-11">
            <input type="checkbox" name={name} value={o.id} defaultChecked={picked.includes(o.id)} className={box} />
            <span className="min-w-0 break-words">{o.name}</span>
          </label>
        ))}
        {shown === 0 ? <p className="m-0 py-2 text-sm text-muted">No match.</p> : null}
      </fieldset>
    </details>
  );
}

/**
 * The Payments filter panel, laid out like the shared Details and Calendar panel: a left column on desktop, a
 * Filters button that opens it inline on phones. It is a GET form, so the filters live in the address bar.
 */
export function PaymentsFilters({ filters, vendors, deputies, active }: Readonly<{ filters: PaymentFilters; vendors: Option[]; deputies: Option[]; active: number }>) {
  const [open, setOpen] = useState(false);
  const [preset, setPreset] = useState<string>(filters.daysPreset);
  return (
    <aside aria-label="Filters" className="flex flex-col gap-2">
      <div className="md:hidden">
        <Button variant="secondary" onClick={() => setOpen(!open)} aria-expanded={open} aria-controls="payments-filter-panel" full>
          <Icon name="sliders" size={18} />
          {active ? `Filters (${active} on)` : "Filters"}
        </Button>
      </div>
      <div id="payments-filter-panel" className={open ? "block" : "hidden md:block"}>
        <Card as="div">
          <form method="get" action="/coordinate/payments" className="flex flex-col gap-3">
            <h2 className="m-0 text-title font-semibold md:text-base">Filters</h2>
            <fieldset className="m-0 flex flex-col border-0 p-0">
              <legend className="mb-1 text-sm font-medium text-muted">Status</legend>
              {(Object.keys(STATUS_TEXT) as PaymentStatusFilter[]).map((s) => (
                <label key={s} className="flex min-h-10 items-center gap-2 text-sm pointer-coarse:min-h-11">
                  <input type="checkbox" name="status" value={s} defaultChecked={filters.statuses.includes(s)} className={box} />
                  {STATUS_TEXT[s]}
                </label>
              ))}
            </fieldset>
            <FormField label="Days waiting on this step">
              <Select name="days" value={preset} onChange={(e) => setPreset(e.target.value)}>
                <option value="">Any</option>
                <option value="0-7">0 to 7 days</option>
                <option value="8-30">8 to 30 days</option>
                <option value="31-">Over 30 days</option>
                <option value="custom">Custom range</option>
              </Select>
            </FormField>
            {preset === "custom" ? (
              <div className="grid grid-cols-2 gap-2">
                <FormField label="From day">
                  <Input name="dmin" inputMode="numeric" defaultValue={filters.days.min ?? ""} />
                </FormField>
                <FormField label="To day">
                  <Input name="dmax" inputMode="numeric" defaultValue={filters.days.max ?? ""} />
                </FormField>
              </div>
            ) : null}
            <SearchGroup legend="Vendor" name="vendor" options={vendors} picked={filters.vendorIds} />
            <SearchGroup legend="Deputy" name="deputy" options={deputies} picked={filters.deputyIds} />
            <fieldset className="m-0 grid grid-cols-2 gap-2 border-0 p-0">
              <legend className="mb-1 text-sm font-medium text-muted">Invoice date</legend>
              <FormField label="From">
                <Input type="date" name="from" defaultValue={filters.from ?? ""} />
              </FormField>
              <FormField label="To">
                <Input type="date" name="to" defaultValue={filters.to ?? ""} />
              </FormField>
            </fieldset>
            <fieldset className="m-0 grid grid-cols-2 gap-2 border-0 p-0">
              <legend className="mb-1 text-sm font-medium text-muted">Amount (dollars)</legend>
              <FormField label="At least">
                <Input name="amin" inputMode="decimal" defaultValue={filters.amountMin === null ? "" : String(filters.amountMin / 100)} />
              </FormField>
              <FormField label="At most">
                <Input name="amax" inputMode="decimal" defaultValue={filters.amountMax === null ? "" : String(filters.amountMax / 100)} />
              </FormField>
            </fieldset>
            <FormField label="Sent to the vendor">
              <Select name="sent" defaultValue={filters.sent ?? ""}>
                <option value="">Sent or not</option>
                <option value="sent">Sent</option>
                <option value="unsent">Not sent</option>
              </Select>
            </FormField>
            <div className="flex flex-wrap gap-2">
              <Button type="submit">Apply</Button>
              <ButtonLink href="/coordinate/payments" variant="secondary">
                Reset
              </ButtonLink>
            </div>
            <p className="m-0 text-xs text-muted">The filters are in the page address, so Back keeps them and a copied link shares them.</p>
          </form>
        </Card>
      </div>
    </aside>
  );
}
