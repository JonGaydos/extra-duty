"use client";

import { useRouter } from "next/navigation";
import { useState, type KeyboardEvent } from "react";
import { AddressField, addressValue } from "@/ui/components/AddressField";
import { Button } from "@/ui/components/Button";
import { FormField, Input, Select } from "@/ui/components/FormField";
import { PhoneField } from "@/ui/components/PhoneField";
import {
  addExceptionAction,
  removeExceptionAction,
  saveContactAction,
  saveGoalAction,
  savePreferenceAction,
  saveQuietHoursAction,
  saveScheduleAction,
  setCalendarLinkAction,
  subscribePushAction,
  syncCalendarAction,
} from "../_personnel/actions";
import type { ActionResult } from "../_personnel/result";
import { ActionStatus, uploadResult, useAction } from "../_personnel/use-action";
import { byNumber } from "@/lib/sort";

/** A chip that holds a hidden native radio: the pointer and the focus ring work as on a button. */
const radioChip = "relative cursor-pointer has-focus-visible:outline-2 has-focus-visible:outline-offset-2 has-focus-visible:outline-focus";
/** Enter on a focused radio would submit the form half-edited; it picks the radio instead, as the old chip buttons did. */
const pickOnEnter = (pick: () => void) => (e: KeyboardEvent<HTMLInputElement>) => {
  if (e.key !== "Enter") return;
  e.preventDefault();
  pick();
};
const chip = (on: boolean) =>
  `inline-flex h-8.5 items-center rounded-full border px-3.5 text-sm transition-colors duration-150 pointer-coarse:h-11 ${
    on ? "border-ink bg-ink font-semibold text-surface" : "border-line bg-surface font-medium text-ink hover:bg-subtle"
  }`;

export function ContactForm({ phone, mailingAddress }: Readonly<{ phone: string; mailingAddress: string }>) {
  const [p, setP] = useState(phone);
  const [a, setA] = useState(() => addressValue(mailingAddress));
  const { run, busy, result } = useAction();
  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        run(() => saveContactAction({ phone: p, mailingAddress: a.address }));
      }}
    >
      <FormField label="Phone">
        <PhoneField value={p} onValue={setP} />
      </FormField>
      <AddressField label="Mailing address" hint="Prints on your invoices so vendors can mail checks." value={a} onChange={setA} multiline maxLength={500} />
      <Button type="submit" busy={busy} className="w-fit">
        Save contact details
      </Button>
      <ActionStatus result={result} />
    </form>
  );
}

export function W9Upload({ hasW9 }: Readonly<{ hasW9: boolean }>) {
  const router = useRouter();
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!file) return;
        setBusy(true);
        setMsg(null);
        try {
          const body = new FormData();
          body.set("file", file);
          const res = await fetch("/api/v1/me/w9", { method: "POST", body });
          const err = res.ok ? null : ((await res.json().catch(() => null)) as { error?: { message?: string } } | null)?.error?.message;
          setMsg(res.ok ? { ok: true, text: "W-9 uploaded." } : { ok: false, text: err ?? "The W-9 could not be uploaded. Use a PDF under 20 MB." });
          if (res.ok) router.refresh();
        } catch {
          setMsg({ ok: false, text: "The W-9 could not be uploaded. Check your connection and try again." });
        } finally {
          setBusy(false);
        }
      }}
    >
      <FormField label={hasW9 ? "Replace your W-9" : "Upload your W-9"} hint="PDF only. Stored encrypted; only you and the extra duty office can open it.">
        <Input type="file" accept="application/pdf" onChange={(e) => setFile(e.target.files?.[0] ?? null)} className="py-2" />
      </FormField>
      <Button type="submit" variant="secondary" busy={busy} disabled={!file} className="w-fit">
        Upload W-9
      </Button>
      <ActionStatus result={uploadResult(msg)} />
    </form>
  );
}

const PATTERNS = [
  { value: "11001110011000", label: "2-2-3 (14 days)" },
  { value: "11110000", label: "4 on, 4 off (8 days)" },
  { value: "111000", label: "3 on, 3 off (6 days)" },
  { value: "custom", label: "Custom" },
];
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const BUFFERS = [
  { v: 0, l: "None" },
  { v: 15, l: "15 min" },
  { v: 30, l: "30 min" },
  { v: 45, l: "45 min" },
  { v: 60, l: "1 hour" },
];

export type ScheduleValue = { kind: "weekly" | "rotation"; weekdays: number[]; cycle: string; anchorDate: string; shiftStart: string; shiftEnd: string; bufferMinutes: number; active: boolean };

export function ScheduleEditor({ initial }: Readonly<{ initial: ScheduleValue }>) {
  const [s, setS] = useState(initial);
  const preset = PATTERNS.some((p) => p.value === s.cycle) ? s.cycle : "custom";
  const [pattern, setPattern] = useState(preset);
  const { run, busy, result } = useAction();
  const set = (patch: Partial<ScheduleValue>) => setS((v) => ({ ...v, ...patch }));
  return (
    <form
      className="flex flex-col gap-3.5"
      onSubmit={(e) => {
        e.preventDefault();
        run(() =>
          saveScheduleAction(
            s.kind === "weekly"
              ? { kind: "weekly", weekdays: s.weekdays, shiftStart: s.shiftStart, shiftEnd: s.shiftEnd, bufferMinutes: s.bufferMinutes }
              : { kind: "rotation", cycle: s.cycle, anchorDate: s.anchorDate, shiftStart: s.shiftStart, shiftEnd: s.shiftEnd, bufferMinutes: s.bufferMinutes },
          ),
        );
      }}
    >
      <div role="radiogroup" aria-label="Schedule type" className="flex gap-2">
        {(["weekly", "rotation"] as const).map((k) => (
          <label key={k} className={`${chip(s.kind === k)} ${radioChip}`}>
            <input type="radio" name="schedule-kind" value={k} checked={s.kind === k} onChange={() => set({ kind: k })} onKeyDown={pickOnEnter(() => set({ kind: k }))} className="sr-only" />
            {k === "weekly" ? "Weekly" : "Rotation"}
          </label>
        ))}
      </div>
      {s.kind === "weekly" ? (
        <fieldset className="m-0 border-0 p-0">
          <legend className="mb-1.5 text-sm font-medium text-muted">Days you work</legend>
          <div className="flex flex-wrap gap-2">
            {DAYS.map((d, i) => (
              <button
                key={d}
                type="button"
                aria-pressed={s.weekdays.includes(i)}
                className={chip(s.weekdays.includes(i))}
                onClick={() => set({ weekdays: s.weekdays.includes(i) ? s.weekdays.filter((x) => x !== i) : [...s.weekdays, i].sort(byNumber) })}
              >
                {d}
              </button>
            ))}
          </div>
        </fieldset>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          <FormField label="Pattern">
            <Select
              value={pattern}
              onChange={(e) => {
                setPattern(e.target.value);
                if (e.target.value !== "custom") set({ cycle: e.target.value });
              }}
            >
              {PATTERNS.map((p) => (
                <option key={p.value} value={p.value}>
                  {p.label}
                </option>
              ))}
            </Select>
          </FormField>
          <FormField label="First work day" hint="Day 1 of the pattern.">
            <Input type="date" value={s.anchorDate} onChange={(e) => set({ anchorDate: e.target.value })} required />
          </FormField>
          {pattern === "custom" ? (
            <div className="sm:col-span-2">
              <FormField label="Custom pattern" hint="One digit per day from the first work day: 1 works, 0 off. Example 11001110011000.">
                <Input value={s.cycle} onChange={(e) => set({ cycle: e.target.value.replace(/[^01]/g, "") })} inputMode="numeric" maxLength={60} />
              </FormField>
            </div>
          ) : null}
        </div>
      )}
      <div className="grid grid-cols-2 gap-3">
        <FormField label="Shift start">
          <Input type="time" value={s.shiftStart} onChange={(e) => set({ shiftStart: e.target.value })} required />
        </FormField>
        <FormField label="Shift end">
          <Input type="time" value={s.shiftEnd} onChange={(e) => set({ shiftEnd: e.target.value })} required />
        </FormField>
      </div>
      <fieldset className="m-0 border-0 p-0">
        <legend className="mb-1.5 text-sm font-medium text-muted">Travel buffer before and after shifts</legend>
        <div role="radiogroup" aria-label="Travel buffer" className="flex flex-wrap gap-2">
          {BUFFERS.map((b) => (
            <label key={b.v} className={`${chip(s.bufferMinutes === b.v)} ${radioChip}`}>
              <input type="radio" name="travel-buffer" value={b.v} checked={s.bufferMinutes === b.v} onChange={() => set({ bufferMinutes: b.v })} onKeyDown={pickOnEnter(() => set({ bufferMinutes: b.v }))} className="sr-only" />
              {b.l}
            </label>
          ))}
        </div>
      </fieldset>
      <div className="flex flex-wrap gap-2">
        <Button type="submit" busy={busy}>
          Save schedule
        </Button>
        {initial.active ? (
          <Button type="button" variant="secondary" busy={busy} onClick={() => run(() => saveScheduleAction(null))}>
            Turn off schedule
          </Button>
        ) : null}
      </div>
      <ActionStatus result={result} />
    </form>
  );
}

export function ExceptionForm({ today }: Readonly<{ today: string }>) {
  const [open, setOpen] = useState(false);
  const [date, setDate] = useState(today);
  const [kind, setKind] = useState<"off" | "extra">("off");
  const [start, setStart] = useState("18:00");
  const [end, setEnd] = useState("06:00");
  const { run, busy, result } = useAction();
  if (!open)
    return (
      <div className="flex flex-col gap-2">
        <Button variant="secondary" className="w-fit" onClick={() => setOpen(true)}>
          Add a one-off change
        </Button>
        <ActionStatus result={result} />
      </div>
    );
  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        run(() => addExceptionAction(kind === "off" ? { date, kind } : { date, kind, shiftStart: start, shiftEnd: end }), () => setOpen(false));
      }}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <FormField label="Date">
          <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} required />
        </FormField>
        <FormField label="Change">
          <Select value={kind} onChange={(e) => setKind(e.target.value as "off" | "extra")}>
            <option value="off">Day off (leave or swap)</option>
            <option value="extra">Extra shift</option>
          </Select>
        </FormField>
        {kind === "extra" ? (
          <>
            <FormField label="Extra shift start">
              <Input type="time" value={start} onChange={(e) => setStart(e.target.value)} required />
            </FormField>
            <FormField label="Extra shift end">
              <Input type="time" value={end} onChange={(e) => setEnd(e.target.value)} required />
            </FormField>
          </>
        ) : null}
      </div>
      <div className="flex gap-2">
        <Button type="submit" busy={busy}>
          Add change
        </Button>
        <Button type="button" variant="secondary" onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>
      <ActionStatus result={result} />
    </form>
  );
}

export function RemoveException({ id, label }: Readonly<{ id: string; label: string }>) {
  const { run, busy, result } = useAction();
  return (
    <span className="flex flex-col items-end gap-1">
      <button type="button" disabled={busy} onClick={() => run(() => removeExceptionAction(id))} aria-label={`Remove ${label}`} className="inline-flex min-h-11 items-center px-1 text-sm font-semibold text-link hover:underline disabled:opacity-55">
        Remove
      </button>
      <ActionStatus result={result} />
    </span>
  );
}

export function CalendarLinkForm({ connected }: Readonly<{ connected: boolean }>) {
  const [url, setUrl] = useState("");
  const { run, busy, result } = useAction();
  return (
    <div className="flex flex-col gap-3">
      <form
        className="flex flex-col gap-2.5"
        onSubmit={(e) => {
          e.preventDefault();
          run(() => setCalendarLinkAction(url), () => setUrl(""));
        }}
      >
        <FormField label={connected ? "Replace the calendar link" : "Calendar link (.ics)"} hint="From Outlook: Settings, Calendar, Shared calendars, Publish a calendar, ICS link.">
          <Input type="url" inputMode="url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://outlook.office365.com/owa/calendar/..." />
        </FormField>
        <Button type="submit" variant="secondary" busy={busy} disabled={!url.trim()} className="w-fit">
          Save link
        </Button>
      </form>
      {connected ? (
        <div className="flex flex-wrap gap-2">
          <Button size="sm" busy={busy} onClick={() => run(() => syncCalendarAction())}>
            Sync now
          </Button>
          <Button size="sm" variant="secondary" busy={busy} onClick={() => run(() => setCalendarLinkAction(null))}>
            Remove link
          </Button>
        </div>
      ) : null}
      <ActionStatus result={result} />
    </div>
  );
}

export function GoalForm({ dollars }: Readonly<{ dollars: string }>) {
  const [v, setV] = useState(dollars);
  const { run, busy, result } = useAction();
  return (
    <form
      className="flex flex-col gap-2.5"
      onSubmit={(e) => {
        e.preventDefault();
        run(() => saveGoalAction(v));
      }}
    >
      <FormField label="Monthly earnings goal" hint="In dollars. Leave blank for no goal.">
        <Input inputMode="decimal" value={v} onChange={(e) => setV(e.target.value)} placeholder="800" />
      </FormField>
      <Button type="submit" variant="secondary" busy={busy} className="w-fit">
        Save goal
      </Button>
      <ActionStatus result={result} />
    </form>
  );
}

/** "email", "push" or "email and push": the channels the agency turned off, or "" for none. */
function offText(o: { email: boolean; push: boolean } | undefined): string {
  if (!o) return "";
  return [o.email ? "email" : "", o.push ? "push" : ""].filter(Boolean).join(" and ");
}

export function AlertPrefs({
  types,
  prefs,
  agencyOff = {},
}: Readonly<{
  types: Array<{ type: string; label: string }>;
  prefs: Record<string, { email: boolean; push: boolean }>;
  /** Channels the agency turned off for everyone in the person's group: shown off and disabled, with a note. */
  agencyOff?: Partial<Record<string, { email: boolean; push: boolean }>>;
}>) {
  const [state, setState] = useState(prefs);
  const [saving, setSaving] = useState<string | null>(null);
  const [result, setResult] = useState<ActionResult | null>(null);
  const get = (t: string) => state[t] ?? { email: true, push: true };
  // One save at a time; a failed save puts the box back and says so.
  const toggle = async (t: string, k: "email" | "push") => {
    if (saving) return;
    const prev = get(t);
    const next = { ...prev, [k]: !prev[k] };
    setState((s) => ({ ...s, [t]: next }));
    setSaving(t);
    try {
      const r = await savePreferenceAction({ type: t, ...next });
      setResult(r);
      if (!r.ok) setState((s) => ({ ...s, [t]: prev }));
    } catch {
      setState((s) => ({ ...s, [t]: prev }));
      setResult({ ok: false, error: "That alert choice was not saved. Check your connection and try again." });
    } finally {
      setSaving(null);
    }
  };
  return (
    <div className="flex flex-col gap-2">
      <table className="w-full border-collapse text-body">
        <caption className="sr-only">Alert choices</caption>
        <thead>
          <tr>
            <th scope="col" className="py-2 text-left text-xs font-semibold text-muted">
              Alert
            </th>
            <th scope="col" className="w-16 py-2 text-center text-xs font-semibold text-muted">
              Email
            </th>
            <th scope="col" className="w-16 py-2 text-center text-xs font-semibold text-muted">
              Push
            </th>
          </tr>
        </thead>
        <tbody>
          {types.map((t) => (
            <tr key={t.type} className="border-t border-divider">
              <th scope="row" className="py-1 pr-2 text-left font-normal">
                {t.label}
                {offText(agencyOff[t.type]) ? <span className="block text-xs text-muted">Turned off by your agency: {offText(agencyOff[t.type])}</span> : null}
              </th>
              {(["email", "push"] as const).map((k) => {
                const off = agencyOff[t.type]?.[k] === true;
                return (
                  <td key={k} className="text-center">
                    <label className={`inline-flex size-11 items-center justify-center${off ? " cursor-not-allowed" : ""}`}>
                      <input
                        type="checkbox"
                        checked={off ? false : get(t.type)[k]}
                        disabled={off || saving !== null}
                        onChange={() => void toggle(t.type, k)}
                        className="size-4.5 accent-accent"
                        aria-label={`${k === "email" ? "Email" : "Push"}: ${t.label}${off ? ". Turned off by your agency" : ""}`}
                      />
                    </label>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      <p className="m-0 text-xs text-muted">Every alert also goes to your in-app inbox. Coordinator messages always reach you.</p>
      <ActionStatus result={result} />
    </div>
  );
}

export function QuietHoursForm({ enabled, start, end }: Readonly<{ enabled: boolean; start: string; end: string }>) {
  const [on, setOn] = useState(enabled);
  const [s, setS] = useState(start);
  const [e2, setE] = useState(end);
  const { run, busy, result } = useAction();
  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        run(() => saveQuietHoursAction(on ? { start: s, end: e2 } : null));
      }}
    >
      <label className="flex min-h-11 items-center gap-2.5">
        <input type="checkbox" checked={on} onChange={(e) => setOn(e.target.checked)} className="size-4.5 accent-accent" />Hold push alerts during quiet hours
      </label>
      {on ? (
        <div className="grid grid-cols-2 gap-3">
          <FormField label="From">
            <Input type="time" value={s} onChange={(e) => setS(e.target.value)} required />
          </FormField>
          <FormField label="Until">
            <Input type="time" value={e2} onChange={(e) => setE(e.target.value)} required />
          </FormField>
        </div>
      ) : null}
      <Button type="submit" variant="secondary" busy={busy} className="w-fit">
        Save quiet hours
      </Button>
      <ActionStatus result={result} />
    </form>
  );
}

function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padded = (base64 + "=".repeat((4 - (base64.length % 4)) % 4)).replaceAll("-", "+").replaceAll("_", "/");
  const raw = atob(padded);
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.codePointAt(i)!;
  return out;
}

function pushState(devices: number): string {
  if (devices > 0) return `Push is on for ${devices} ${devices === 1 ? "device" : "devices"}.`;
  return "Push is off on all your devices.";
}

export function PushEnable({ vapidKey, devices }: Readonly<{ vapidKey: string | null; devices: number }>) {
  const { run, busy, result } = useAction();
  const [error, setError] = useState<string | null>(null);
  if (!vapidKey) return <p className="m-0 text-sm text-muted">Push alerts are not set up for this agency yet. You still get email and in-app alerts.</p>;
  return (
    <div className="flex flex-col gap-2.5">
      <p className="m-0 text-sm text-muted">{pushState(devices)} Turn it on for each phone or computer you use.</p>
      <Button
        variant="secondary"
        busy={busy}
        className="w-fit"
        onClick={async () => {
          setError(null);
          try {
            if (!("serviceWorker" in navigator) || !("PushManager" in window)) throw new Error("This browser does not support push alerts. On iPhone, add Extra Duty to your Home Screen first.");
            const permission = await Notification.requestPermission();
            if (permission !== "granted") throw new Error("Notifications are blocked for this site. Allow them in your browser settings.");
            const reg = await navigator.serviceWorker.ready;
            const sub = (await reg.pushManager.getSubscription()) ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(vapidKey) }));
            run(() => subscribePushAction(sub.toJSON()));
          } catch (e) {
            setError(e instanceof Error ? e.message : "Push alerts could not be turned on.");
          }
        }}
      >
        Turn on push for this device
      </Button>
      <ActionStatus result={error ? { ok: false, error } : result} />
    </div>
  );
}
