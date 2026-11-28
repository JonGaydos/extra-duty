"use client";

import { useState } from "react";
import { AUDIT_GROUPS, DATE_PRESETS, type AuditQuery } from "@/domain/audit/labels";
import { Button, ButtonLink } from "@/ui/components/Button";
import { Card } from "@/ui/components/Card";
import { FormField, Input, Select } from "@/ui/components/FormField";
import { Icon } from "@/ui/icons";

type Option = { id: string; name: string };

const box = "size-4.5 shrink-0 accent-accent";

/** One person, searchable: a collapsible list of radio rows with a search box, and Anyone. */
function PersonPick({ legend, name, options, picked }: Readonly<{ legend: string; name: string; options: Option[]; picked?: string }>) {
  const [q, setQ] = useState("");
  const needle = q.trim().toLowerCase();
  const current = options.find((o) => o.id === picked);
  const match = (o: Option) => !needle || o.name.toLowerCase().includes(needle);
  return (
    <details className="group rounded-md border border-line" open={!!current}>
      <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-2 px-3 text-sm font-medium [&::-webkit-details-marker]:hidden">
        <span className="min-w-0">
          {legend}
          {current ? <span className="text-muted">: {current.name}</span> : null}
        </span>
        <Icon name="chevronRight" size={16} className="shrink-0 transition-transform group-open:rotate-90" />
      </summary>
      <div className="border-t border-divider px-3 pt-2">
        <Input type="search" aria-label={`Search ${legend.toLowerCase()}`} placeholder="Search by name" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      <fieldset className="m-0 flex max-h-56 flex-col overflow-y-auto border-0 px-3 py-1">
        <legend className="sr-only">{legend}</legend>
        <label className="flex min-h-10 items-center gap-2 text-sm pointer-coarse:min-h-11">
          <input type="radio" name={name} value="" defaultChecked={!current} className={box} />
          <span>Anyone</span>
        </label>
        {options.map((o) => (
          <label key={o.id} hidden={!match(o)} className="flex min-h-10 items-center gap-2 text-sm pointer-coarse:min-h-11">
            <input type="radio" name={name} value={o.id} defaultChecked={o.id === picked} className={box} />
            <span className="min-w-0 break-words">{o.name}</span>
          </label>
        ))}
        {options.every((o) => !match(o)) ? <p className="m-0 py-2 text-sm text-muted">No match.</p> : null}
      </fieldset>
    </details>
  );
}

/**
 * The audit log's filter panel, laid out like the shared panel: a left column on desktop, a Filters button that opens it
 * inline on phones. A GET form, so every filter lives in the address bar.
 */
export function AuditFilters({ q, people, vendors, active }: Readonly<{ q: AuditQuery; people: Option[]; vendors: Option[]; active: number }>) {
  const [open, setOpen] = useState(false);
  const [preset, setPreset] = useState<string>(q.preset ?? "");
  const groups = q.groups ?? [];
  return (
    <aside aria-label="Filters" className="flex flex-col gap-2">
      <div className="md:hidden">
        <Button variant="secondary" onClick={() => setOpen(!open)} aria-expanded={open} aria-controls="audit-filter-panel" full>
          <Icon name="sliders" size={18} />
          {active ? `Filters (${active} on)` : "Filters"}
        </Button>
      </div>
      <div id="audit-filter-panel" className={open ? "block" : "hidden md:block"}>
        <Card as="div">
          <form method="get" action="/admin/audit" className="flex flex-col gap-3">
            <h2 className="m-0 text-title font-semibold md:text-base">Filters</h2>
            <FormField label="Search" hint="Reason and summary.">
              <Input type="search" name="q" defaultValue={q.text ?? ""} maxLength={200} />
            </FormField>
            <PersonPick legend="Done by" name="by" options={people} picked={q.doneBy} />
            <PersonPick legend="About" name="about" options={people} picked={q.about} />
            <details className="group rounded-md border border-line" open={groups.length > 0}>
              <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-2 px-3 text-sm font-medium [&::-webkit-details-marker]:hidden">
                <span>
                  Action type
                  {groups.length ? <span className="text-muted"> ({groups.length})</span> : null}
                </span>
                <Icon name="chevronRight" size={16} className="transition-transform group-open:rotate-90" />
              </summary>
              <fieldset className="m-0 flex flex-col border-0 border-t border-divider px-3 py-1">
                <legend className="sr-only">Action type</legend>
                {AUDIT_GROUPS.map((g) => (
                  <label key={g.key} className="flex min-h-10 items-center gap-2 text-sm pointer-coarse:min-h-11">
                    <input type="checkbox" name="group" value={g.key} defaultChecked={groups.includes(g.key)} className={box} />
                    {g.label}
                  </label>
                ))}
              </fieldset>
            </details>
            <div className="grid grid-cols-2 gap-2">
              <FormField label="Detail number">
                <Input name="detail" inputMode="numeric" defaultValue={q.detail ?? ""} />
              </FormField>
              <FormField label="Invoice number">
                <Input name="invoice" defaultValue={q.invoice ?? ""} placeholder="ED-000123" />
              </FormField>
            </div>
            <FormField label="Vendor">
              <Select name="vendor" defaultValue={q.vendorId ?? ""}>
                <option value="">Any vendor</option>
                {vendors.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.name}
                  </option>
                ))}
              </Select>
            </FormField>
            <FormField label="Dates" hint="Agency time.">
              <Select name="range" value={preset} onChange={(e) => setPreset(e.target.value)}>
                <option value="">Any time</option>
                {DATE_PRESETS.map((p) => (
                  <option key={p.key} value={p.key}>
                    {p.label}
                  </option>
                ))}
              </Select>
            </FormField>
            {preset === "custom" ? (
              <div className="grid grid-cols-2 gap-2">
                <FormField label="From">
                  <Input type="date" name="from" defaultValue={q.from ?? ""} />
                </FormField>
                <FormField label="To">
                  <Input type="date" name="to" defaultValue={q.to ?? ""} />
                </FormField>
              </div>
            ) : null}
            <FormField label="System actions">
              <Select name="system" defaultValue={q.system === false ? "0" : ""}>
                <option value="">Include system actions</option>
                <option value="0">Leave out system actions</option>
              </Select>
            </FormField>
            <FormField label="Order">
              <Select name="order" defaultValue={q.order ?? "newest"}>
                <option value="newest">Newest first</option>
                <option value="oldest">Oldest first</option>
              </Select>
            </FormField>
            {q.entityType ? <input type="hidden" name="type" value={q.entityType} /> : null}
            {q.entityId ? <input type="hidden" name="id" value={q.entityId} /> : null}
            <div className="flex flex-wrap gap-2">
              <Button type="submit">Apply</Button>
              <ButtonLink href="/admin/audit" variant="secondary">
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
