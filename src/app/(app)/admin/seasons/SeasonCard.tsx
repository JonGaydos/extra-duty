"use client";

import { useId, useState } from "react";
import { Button } from "@/ui/components/Button";
import { Card } from "@/ui/components/Card";
import { FormField, Input } from "@/ui/components/FormField";
import { hoursText } from "../../_personnel/format";
import { Facts } from "../../coordinate/_coordinator/ui";
import { useCoordAction } from "../../coordinate/_coordinator/status";
import { deleteSeasonAction, saveSeasonAction, type SeasonFields } from "../_admin/actions";

export type SeasonView = { id: string; name: string; start: string; end: string; rolling: number | null; week: number | null; month: number | null };

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "01-15" to "Jan 15". */
const md = (v: string) => `${MONTHS[Number(v.slice(0, 2)) - 1] ?? "?"} ${Number(v.slice(3, 5))}`;
const cap = (m: number | null) => (m === null ? "No cap" : hoursText(m));
const hours = (m: number | null) => (m === null ? "" : String(Math.round((m / 60) * 100) / 100));

function SeasonForm({ initial, id, rollingHours, onDone, submit }: { initial: SeasonFields; id?: string; rollingHours: number; onDone: () => void; submit: string }) {
  const [v, setV] = useState(initial);
  const { run, busy } = useCoordAction();
  const set = (k: keyof SeasonFields) => (e: React.ChangeEvent<HTMLInputElement>) => setV({ ...v, [k]: e.target.value });
  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        run(() => saveSeasonAction({ ...v, id }), onDone);
      }}
    >
      <div className="grid gap-3 md:grid-cols-3">
        <div className="md:col-span-3">
          <FormField label="Season name">
            <Input value={v.name} onChange={set("name")} required maxLength={100} />
          </FormField>
        </div>
        <FormField label="Starts (MM-DD)" hint="Such as 06-01.">
          <Input value={v.start} onChange={set("start")} required pattern="\d{2}-\d{2}" inputMode="numeric" data-numeric />
        </FormField>
        <FormField label="Ends (MM-DD)" hint="It may wrap past Dec 31.">
          <Input value={v.end} onChange={set("end")} required pattern="\d{2}-\d{2}" inputMode="numeric" data-numeric />
        </FormField>
      </div>
      <div className="grid gap-3 md:grid-cols-3">
        <FormField label={`Rolling ${rollingHours}-hour cap (hours)`} hint="Blank for no cap.">
          <Input value={v.rolling} onChange={set("rolling")} inputMode="decimal" data-numeric />
        </FormField>
        <FormField label="Week cap (hours)" hint="Blank for no cap.">
          <Input value={v.week} onChange={set("week")} inputMode="decimal" data-numeric />
        </FormField>
        <FormField label="Month cap (hours)" hint="Blank for no cap.">
          <Input value={v.month} onChange={set("month")} inputMode="decimal" data-numeric />
        </FormField>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button type="submit" busy={busy}>
          {submit}
        </Button>
        <Button type="button" variant="secondary" onClick={onDone}>
          Close
        </Button>
      </div>
    </form>
  );
}

/** One season: its dates and caps, with Edit and Delete. */
export function SeasonCard({ season, rollingHours }: { season: SeasonView; rollingHours: number }) {
  const headingId = useId();
  const [editing, setEditing] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const { run, busy } = useCoordAction();
  return (
    <Card aria-labelledby={headingId}>
      <h2 id={headingId} className="m-0 text-title font-semibold md:text-base">
        {season.name}
      </h2>
      {editing ? (
        <SeasonForm
          id={season.id}
          rollingHours={rollingHours}
          submit="Save season"
          onDone={() => setEditing(false)}
          initial={{ name: season.name, start: season.start, end: season.end, rolling: hours(season.rolling), week: hours(season.week), month: hours(season.month) }}
        />
      ) : (
        <>
          <Facts
            items={[
              ["Dates", `${md(season.start)} to ${md(season.end)}`],
              [`Rolling ${rollingHours} hours`, <span key="r" data-numeric>{cap(season.rolling)}</span>],
              ["Week", <span key="w" data-numeric>{cap(season.week)}</span>],
              ["Month", <span key="m" data-numeric>{cap(season.month)}</span>],
            ]}
          />
          {confirm ? (
            <div className="flex flex-col gap-2.5 rounded-md border border-danger-line bg-danger-soft p-3">
              <p className="m-0 text-sm text-danger-ink">Delete {season.name}? Dates it covers will have no hour caps until another season covers them.</p>
              <div className="flex flex-wrap gap-2">
                <Button variant="danger" busy={busy} onClick={() => run(() => deleteSeasonAction(season.id))}>
                  Delete season
                </Button>
                <Button variant="secondary" onClick={() => setConfirm(false)}>
                  Keep season
                </Button>
              </div>
            </div>
          ) : (
            <div className="flex flex-wrap gap-2">
              <Button variant="secondary" onClick={() => setEditing(true)}>
                Edit season
              </Button>
              <Button variant="secondary" onClick={() => setConfirm(true)}>
                Delete
              </Button>
            </div>
          )}
        </>
      )}
    </Card>
  );
}

export function AddSeason({ rollingHours }: { rollingHours: number }) {
  const [open, setOpen] = useState(false);
  if (!open)
    return (
      <Button onClick={() => setOpen(true)} className="w-fit">
        Add season
      </Button>
    );
  return (
    <Card tone="accent" as="div">
      <h2 className="m-0 text-title font-semibold md:text-base">Add season</h2>
      <SeasonForm rollingHours={rollingHours} submit="Add season" onDone={() => setOpen(false)} initial={{ name: "", start: "", end: "", rolling: "", week: "", month: "" }} />
    </Card>
  );
}
