"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useId, useRef, useState } from "react";
import { Button } from "@/ui/components/Button";
import { Input, Select } from "@/ui/components/FormField";
import { Icon } from "@/ui/icons";

const TOGGLES = [
  { key: "open", label: "Open" },
  { key: "mine", label: "Mine" },
  { key: "week", label: "This week" },
  { key: "flex", label: "Flexible times" },
];

const SORTS = [
  { value: "date", label: "Date" },
  { value: "total_pay", label: "Total pay" },
  { value: "rate", label: "Rate" },
  { value: "vendor", label: "Vendor" },
];

type Props = { types: Array<{ id: string; name: string }>; scheduleNote: string; showSort?: boolean };

/** Reads and writes the list filters in the address, so List, Calendar and Map share them and Back works. */
function useFilterParams() {
  const router = useRouter();
  const path = usePathname();
  const params = useSearchParams();
  const set = (key: string, value: string | null) => {
    const next = new URLSearchParams(params.toString());
    if (value === null || value === "") next.delete(key);
    else next.set(key, value);
    const s = next.toString();
    router.replace(s ? `${path}?${s}` : path, { scroll: false });
  };
  return { params, set, on: (key: string) => params.get(key) === "1" };
}

const chip = (pressed: boolean) =>
  `inline-flex h-8.5 items-center rounded-full border px-3.5 text-sm whitespace-nowrap transition-colors duration-150 pointer-coarse:h-11 ${
    pressed ? "border-ink bg-ink font-semibold text-surface" : "border-line bg-surface font-medium text-ink hover:bg-subtle"
  }`;

/** Filter chips, job types, "Only details I can work" and sort. Rendered inline on desktop and in a sheet on phones. */
function Controls({ types, scheduleNote, showSort = true }: Readonly<Props>) {
  const { params, set, on } = useFilterParams();
  const id = useId();
  const type = params.get("type") ?? "";
  return (
    <div className="flex flex-col gap-3">
      <fieldset aria-label="Filters" className="min-w-0 flex flex-wrap gap-2">
        {TOGGLES.map((t) => (
          <button key={t.key} type="button" aria-pressed={on(t.key)} className={chip(on(t.key))} onClick={() => set(t.key, on(t.key) ? null : "1")}>
            {t.label}
          </button>
        ))}
        {types.map((t) => (
          <button key={t.id} type="button" aria-pressed={type === t.id} className={chip(type === t.id)} onClick={() => set("type", type === t.id ? null : t.id)}>
            {t.name}
          </button>
        ))}
      </fieldset>
      <div className="flex items-center justify-between gap-3 rounded-md border border-line bg-surface px-3.5 py-1.5">
        <span className="flex flex-col">
          <span id={`${id}-workable`} className="font-medium">
            Only details I can work
          </span>
          <span className="text-xs text-muted">{scheduleNote}</span>
        </span>
        <button
          type="button"
          role="switch"
          aria-checked={on("workable")}
          aria-labelledby={`${id}-workable`}
          onClick={() => set("workable", on("workable") ? null : "1")}
          className="flex h-11 shrink-0 items-center"
        >
          <span className={`relative inline-flex h-4.5 w-7.5 rounded-full transition-colors duration-150 ${on("workable") ? "bg-accent" : "bg-field"}`}>
            <span className={`absolute top-0.5 size-3.5 rounded-full bg-surface transition-[left] duration-150 ${on("workable") ? "left-3.5" : "left-0.5"}`} />
          </span>
        </button>
      </div>
      {showSort ? (
        <label className="flex items-center gap-2 text-sm whitespace-nowrap text-muted">
          Sort by
          <Select value={params.get("sort") ?? "date"} onChange={(e) => set("sort", e.target.value === "date" ? null : e.target.value)} className="w-auto min-w-0 flex-1 md:flex-none">
            {SORTS.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </Select>
        </label>
      ) : null}
    </div>
  );
}

/**
 * Search plus the filters. On a phone the filters fold into a "Filters" sheet (the button says how many are
 * on) so results start near the top; from 768 px they sit inline beside the list.
 */
export function JobFilters(props: Readonly<Props>) {
  const { params, set } = useFilterParams();
  const [q, setQ] = useState(params.get("q") ?? "");
  const sheet = useRef<HTMLDialogElement>(null);
  const [open, setOpen] = useState(false);
  const active = ["open", "mine", "week", "flex", "workable"].filter((k) => params.get(k) === "1").length + (params.get("type") ? 1 : 0) + (params.get("sort") ? 1 : 0);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex gap-2">
        <form
          role="search"
          onSubmit={(e) => {
            e.preventDefault();
            set("q", q.trim());
          }}
          className="relative min-w-0 flex-1"
        >
          <Icon name="search" size={18} className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-muted" />
          <Input
            type="search"
            aria-label="Search details"
            placeholder="Vendor, place or job #"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onBlur={() => q.trim() !== (params.get("q") ?? "") && set("q", q.trim())}
            className="pl-9.5"
          />
        </form>
        <Button
          variant="secondary"
          className="md:hidden"
          aria-haspopup="dialog"
          onClick={() => {
            setOpen(true);
            sheet.current?.showModal();
          }}
        >
          <Icon name="sliders" size={18} />
          {active ? `Filters (${active})` : "Filters"}
        </Button>
      </div>
      <div className="hidden md:block">
        <Controls {...props} />
      </div>
      <dialog
        ref={sheet}
        aria-labelledby="filters-title"
        onClose={() => setOpen(false)}
        className="mt-auto mb-0 w-full max-w-none rounded-t-2xl border border-line bg-surface p-0 text-ink backdrop:bg-ink/40 md:hidden"
      >
        {open ? (
          <div className="flex flex-col gap-4 p-5 pb-[calc(20px+env(safe-area-inset-bottom))]">
            <h2 id="filters-title" className="m-0 text-lg font-bold">
              Filters
            </h2>
            <Controls {...props} />
            <Button size="lg" full onClick={() => sheet.current?.close()}>
              Show details
            </Button>
          </div>
        ) : null}
      </dialog>
    </div>
  );
}
