"use client";

import { useEffect, useId, useRef, useState } from "react";
import { FormField, Input, Select } from "@/ui/components/FormField";
import { Notice } from "@/ui/components/Notice";
import { Icon } from "@/ui/icons";
import { expandDatesAction } from "./actions";

/** Calendar-day keys (YYYY-MM-DD) read as plain dates, never shifted by a time zone. */
const UTC = (o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat("en-US", { timeZone: "UTC", ...o });
const DAY = UTC({ weekday: "short", month: "short", day: "numeric" });
const MONTH = UTC({ month: "long", year: "numeric" });
const keyDate = (key: string) => new Date(`${key}T12:00:00Z`);
export const keyLabel = (key: string) => DAY.format(keyDate(key));
const pad = (n: number) => String(n).padStart(2, "0");
const toKey = (y: number, m: number, d: number) => `${y}-${pad(m)}-${pad(d)}`;

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const WEEKDAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export type DateMode = "one" | "range" | "pick" | "repeat";
const TABS: Array<{ key: DateMode; label: string }> = [
  { key: "one", label: "One date" },
  { key: "range", label: "Range" },
  { key: "pick", label: "Pick dates" },
  { key: "repeat", label: "Repeat" },
];

/** Toggle chips for weekdays: real buttons with aria-pressed. */
function WeekdayChips({ value, onChange, label }: { value: number[]; onChange: (v: number[]) => void; label: string }) {
  return (
    <div role="group" aria-label={label} className="flex flex-wrap gap-1.5">
      {WEEKDAYS.map((w, i) => {
        const on = value.includes(i);
        return (
          <button
            key={w}
            type="button"
            aria-pressed={on}
            onClick={() => onChange(on ? value.filter((x) => x !== i) : [...value, i].sort())}
            className={`h-9 min-w-12 rounded-full border px-3 text-sm pointer-coarse:h-11 ${on ? "border-ink bg-ink font-semibold text-surface" : "border-line bg-surface text-ink hover:bg-subtle"}`}
          >
            <span aria-hidden>{w}</span>
            <span className="sr-only">{WEEKDAY_NAMES[i]}</span>
          </button>
        );
      })}
    </div>
  );
}

/** A month grid; each day is a toggle button. */
function MonthPicker({ selected, onToggle, today, weekStartsOn, minDate }: { selected: Set<string>; onToggle: (key: string) => void; today: string; weekStartsOn: number; minDate?: string }) {
  const [ym, setYm] = useState(() => {
    const first = [...selected].sort()[0] ?? today;
    return { y: Number(first.slice(0, 4)), m: Number(first.slice(5, 7)) };
  });
  const headingId = useId();
  const days = new Date(Date.UTC(ym.y, ym.m, 0)).getUTCDate();
  const lead = (new Date(Date.UTC(ym.y, ym.m - 1, 1)).getUTCDay() - weekStartsOn + 7) % 7;
  const shift = (n: number) => setYm(({ y, m }) => ({ y: Math.floor((y * 12 + m - 1 + n) / 12), m: ((m - 1 + n + 1200) % 12) + 1 }));
  const cells: Array<string | null> = [...Array(lead).fill(null), ...Array.from({ length: days }, (_, i) => toKey(ym.y, ym.m, i + 1))];
  const order = Array.from({ length: 7 }, (_, i) => (i + weekStartsOn) % 7);
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <button type="button" onClick={() => shift(-1)} className="flex size-11 items-center justify-center rounded-full border border-line bg-surface hover:bg-subtle" aria-label="Previous month">
          <Icon name="chevronLeft" size={18} />
        </button>
        <h3 id={headingId} className="m-0 text-body font-semibold" aria-live="polite">
          {MONTH.format(new Date(Date.UTC(ym.y, ym.m - 1, 1)))}
        </h3>
        <button type="button" onClick={() => shift(1)} className="flex size-11 items-center justify-center rounded-full border border-line bg-surface hover:bg-subtle" aria-label="Next month">
          <Icon name="chevronRight" size={18} />
        </button>
      </div>
      <div role="group" aria-labelledby={headingId} className="grid grid-cols-7 gap-1">
        {order.map((d) => (
          <span key={d} className="py-1 text-center text-xs font-semibold text-muted" aria-hidden>
            {WEEKDAYS[d].slice(0, 2)}
          </span>
        ))}
        {cells.map((k, i) =>
          k ? (
            <button
              key={k}
              type="button"
              aria-pressed={selected.has(k)}
              aria-label={keyLabel(k)}
              disabled={!!minDate && k < minDate}
              onClick={() => onToggle(k)}
              className={`flex h-11 items-center justify-center rounded-xs border text-body disabled:cursor-not-allowed disabled:border-transparent disabled:bg-transparent disabled:text-muted ${
                selected.has(k) ? "border-accent bg-accent font-semibold text-on-accent" : k === today ? "border-accent-outline bg-surface text-ink hover:bg-subtle" : "border-line bg-surface text-ink hover:bg-subtle"
              }`}
              data-numeric
            >
              {Number(k.slice(8))}
            </button>
          ) : (
            <span key={`lead-${i}`} aria-hidden />
          ),
        )}
      </div>
    </div>
  );
}

type Repeat = { start: string; kind: "daily" | "weekly" | "monthly"; every: string; weekdays: number[]; endKind: "count" | "until"; count: string; until: string };

/**
 * The Dates step: one date, a range (with optional weekdays), dates picked on a month calendar, or a repeat
 * pattern. Range and repeat are expanded by the server's own rules; the result goes to `onDates`.
 */
export function DatesStep({
  today,
  weekStartsOn,
  onDates,
  modes = ["one", "range", "pick", "repeat"],
  initial = "one",
  minDate,
  expand = expandDatesAction,
}: {
  /** Expands a range or repeat on the server; the vendor portal passes its own action. */
  expand?: typeof expandDatesAction;
  today: string;
  weekStartsOn: number;
  onDates: (dates: string[]) => void;
  modes?: DateMode[];
  initial?: DateMode;
  /** Earliest date that may be chosen (copies refuse past dates). */
  minDate?: string;
}) {
  const [mode, setMode] = useState<DateMode>(initial);
  const [one, setOne] = useState("");
  const [range, setRange] = useState({ from: "", to: "", weekdays: [] as number[] });
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [repeat, setRepeat] = useState<Repeat>({ start: "", kind: "weekly", every: "1", weekdays: [], endKind: "count", count: "4", until: "" });
  const [error, setError] = useState<string | null>(null);
  const tabs = TABS.filter((t) => modes.includes(t.key));
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const baseId = useId();
  const sent = useRef(onDates);
  sent.current = onDates;

  useEffect(() => {
    let live = true;
    const done = (d: string[]) => live && sent.current(minDate ? d.filter((x) => x >= minDate) : d);
    setError(null);
    if (mode === "one") {
      done(/^\d{4}-\d{2}-\d{2}$/.test(one) ? [one] : []);
      return;
    }
    if (mode === "pick") {
      done([...picked].sort());
      return;
    }
    let call: Parameters<typeof expandDatesAction> | null = null;
    if (mode === "range" && range.from && range.to) {
      call = [{ kind: "range", from: range.from, to: range.to, ...(range.weekdays.length ? { weekdays: range.weekdays } : {}) }, range.from];
    }
    if (mode === "repeat" && repeat.start) {
      const every = Number(repeat.every) || 1;
      const end = repeat.endKind === "count" ? { count: Number(repeat.count) || 1 } : { until: repeat.until as unknown as Date };
      const recurrence =
        repeat.kind === "daily"
          ? { kind: "daily" as const, every, end }
          : repeat.kind === "weekly"
            ? { kind: "weekly" as const, every, weekdays: repeat.weekdays.length ? repeat.weekdays : [keyDate(repeat.start).getUTCDay()], end }
            : { kind: "monthly" as const, every, dayOfMonth: Number(repeat.start.slice(8)), end };
      if (repeat.endKind === "count" || repeat.until) call = [{ kind: "pattern", recurrence }, repeat.start];
    }
    if (!call) {
      done([]);
      return;
    }
    const args = call;
    const timer = setTimeout(async () => {
      try {
        const r = await expand(...args);
        if (!live) return;
        if (r.ok) done(JSON.parse(r.value ?? "[]"));
        else {
          setError(r.error);
          done([]);
        }
      } catch {
        if (!live) return;
        setError("Could not work out the dates. Check your connection and try again.");
        // A failed expansion never leaves the last list in place.
        done([]);
      }
    }, 250);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [mode, one, range, picked, repeat, minDate, expand]);

  const onKey = (e: React.KeyboardEvent, i: number) => {
    const next = e.key === "ArrowRight" ? i + 1 : e.key === "ArrowLeft" ? i - 1 : e.key === "Home" ? 0 : e.key === "End" ? tabs.length - 1 : null;
    if (next === null) return;
    e.preventDefault();
    const j = (next + tabs.length) % tabs.length;
    setMode(tabs[j].key);
    tabRefs.current[j]?.focus();
  };

  return (
    <div className="flex flex-col gap-3">
      <div role="tablist" aria-label="How to choose dates" className="flex flex-wrap gap-1 rounded-md border border-line bg-surface p-1">
        {tabs.map((t, i) => (
          <button
            key={t.key}
            ref={(el) => {
              tabRefs.current[i] = el;
            }}
            type="button"
            role="tab"
            id={`${baseId}-${t.key}`}
            aria-selected={mode === t.key}
            aria-controls={`${baseId}-panel`}
            tabIndex={mode === t.key ? 0 : -1}
            onClick={() => setMode(t.key)}
            onKeyDown={(e) => onKey(e, i)}
            className={`min-h-9 flex-1 rounded-sm px-3 text-body whitespace-nowrap pointer-coarse:min-h-11 ${mode === t.key ? "bg-accent-soft font-semibold text-link" : "font-medium text-muted hover:bg-subtle hover:text-ink"}`}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div role="tabpanel" id={`${baseId}-panel`} aria-labelledby={`${baseId}-${mode}`} className="flex flex-col gap-3">
        {mode === "one" ? (
          <FormField label="Date">
            <Input type="date" value={one} onChange={(e) => setOne(e.target.value)} />
          </FormField>
        ) : null}
        {mode === "range" ? (
          <>
            <div className="grid grid-cols-2 gap-3">
              <FormField label="From">
                <Input type="date" value={range.from} min={minDate} onChange={(e) => setRange({ ...range, from: e.target.value })} />
              </FormField>
              <FormField label="To">
                <Input type="date" value={range.to} min={range.from || undefined} onChange={(e) => setRange({ ...range, to: e.target.value })} />
              </FormField>
            </div>
            <div className="flex flex-col gap-1.5">
              <span className="text-sm font-medium text-muted">Only on these days (optional)</span>
              <WeekdayChips label="Only on these days" value={range.weekdays} onChange={(w) => setRange({ ...range, weekdays: w })} />
            </div>
          </>
        ) : null}
        {mode === "pick" ? (
          <MonthPicker
            minDate={minDate}
            today={today}
            weekStartsOn={weekStartsOn}
            selected={picked}
            onToggle={(k) =>
              setPicked((s) => {
                const n = new Set(s);
                if (n.has(k)) n.delete(k);
                else n.add(k);
                return n;
              })
            }
          />
        ) : null}
        {mode === "repeat" ? (
          <div className="grid gap-3 sm:grid-cols-2">
            <FormField label="Starts on">
              <Input type="date" value={repeat.start} onChange={(e) => setRepeat({ ...repeat, start: e.target.value })} />
            </FormField>
            <FormField label="Repeats">
              <Select value={repeat.kind} onChange={(e) => setRepeat({ ...repeat, kind: e.target.value as Repeat["kind"] })}>
                <option value="daily">Daily</option>
                <option value="weekly">Weekly</option>
                <option value="monthly">Monthly, same day of the month</option>
              </Select>
            </FormField>
            <FormField label={repeat.kind === "daily" ? "Every how many days" : repeat.kind === "weekly" ? "Every how many weeks" : "Every how many months"}>
              <Input type="number" inputMode="numeric" min={1} max={52} value={repeat.every} onChange={(e) => setRepeat({ ...repeat, every: e.target.value })} />
            </FormField>
            {repeat.kind === "weekly" ? (
              <div className="flex flex-col gap-1.5 sm:col-span-2">
                <span className="text-sm font-medium text-muted">On</span>
                <WeekdayChips label="Repeat on" value={repeat.weekdays} onChange={(w) => setRepeat({ ...repeat, weekdays: w })} />
              </div>
            ) : null}
            <fieldset className="m-0 flex flex-col gap-2 border-0 p-0 sm:col-span-2">
              <legend className="mb-1.5 text-sm font-medium text-muted">Ends</legend>
              <div className="flex flex-wrap items-center gap-3">
                <label className="flex min-h-11 items-center gap-2">
                  <input type="radio" name={`${baseId}-end`} checked={repeat.endKind === "count"} onChange={() => setRepeat({ ...repeat, endKind: "count" })} className="size-4.5 accent-accent" />
                  After
                </label>
                <Input aria-label="Number of details" type="number" inputMode="numeric" min={1} max={366} value={repeat.count} onChange={(e) => setRepeat({ ...repeat, count: e.target.value, endKind: "count" })} className="max-w-24" />
                <span className="text-muted">times</span>
              </div>
              <div className="flex flex-wrap items-center gap-3">
                <label className="flex min-h-11 items-center gap-2">
                  <input type="radio" name={`${baseId}-end`} checked={repeat.endKind === "until"} onChange={() => setRepeat({ ...repeat, endKind: "until" })} className="size-4.5 accent-accent" />
                  On
                </label>
                <Input aria-label="Last date" type="date" value={repeat.until} onChange={(e) => setRepeat({ ...repeat, until: e.target.value, endKind: "until" })} className="w-auto" />
              </div>
            </fieldset>
          </div>
        ) : null}
        {error ? <Notice tone="danger">{error}</Notice> : null}
      </div>
    </div>
  );
}
