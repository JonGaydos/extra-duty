"use client";

import { useId } from "react";
import { FormField, TextArea } from "@/ui/components/FormField";
import { REMINDER_CHOICES, reminderSummary } from "@/domain/jobs/reminder-choices";
import type { ReminderWire } from "./detail-input";

const check = "size-4.5 shrink-0 accent-accent";

/**
 * Reminders before the start on the detail form: the agency's times, this detail's own times, or none, and a note
 * added to each reminder. The people assigned get the reminder by email, push and in the app.
 */
export function ReminderFields({
  value,
  note,
  agencyHours,
  onChange,
  onNote,
}: Readonly<{ value: ReminderWire; note: string; agencyHours: number[]; onChange: (v: ReminderWire) => void; onNote: (v: string) => void }>) {
  const name = useId();
  const agency = agencyHours.length ? `Agency times: ${reminderSummary(agencyHours)}` : "Agency times: the agency sends no reminders";
  const choose = (mode: ReminderWire["mode"]) => onChange({ mode, hours: mode === "custom" && value.hours.length === 0 ? [...agencyHours] : value.hours });
  return (
    <div className="flex flex-col gap-3">
      <fieldset className="m-0 flex flex-col gap-0.5 border-0 p-0">
        <legend className="mb-1 p-0 text-sm font-medium text-muted">Remind the people assigned</legend>
        <label className="flex min-h-11 items-center gap-2">
          <input type="radio" name={name} checked={value.mode === "agency"} onChange={() => choose("agency")} className={check} />
          <span>{agency}</span>
        </label>
        <label className="flex min-h-11 items-center gap-2">
          <input type="radio" name={name} checked={value.mode === "custom"} onChange={() => choose("custom")} className={check} />
          <span>Different times for this detail</span>
        </label>
        {value.mode === "custom" ? (
          <fieldset className="m-0 flex flex-wrap gap-x-5 border-0 p-0 pl-6.5">
            <legend className="sr-only">Reminder times for this detail</legend>
            {REMINDER_CHOICES.map((h) => (
              <label key={h} className="flex min-h-11 items-center gap-2">
                <input
                  type="checkbox"
                  checked={value.hours.includes(h)}
                  onChange={(e) => onChange({ mode: "custom", hours: e.target.checked ? [...value.hours, h] : value.hours.filter((x) => x !== h) })}
                  className={check}
                />
                <span>{h} hours before</span>
              </label>
            ))}
          </fieldset>
        ) : null}
        <label className="flex min-h-11 items-center gap-2">
          <input type="radio" name={name} checked={value.mode === "off"} onChange={() => choose("off")} className={check} />
          <span>No reminders for this detail</span>
        </label>
      </fieldset>
      {value.mode === "off" ? null : (
        <FormField label="Reminder note" hint="Optional. Added to each reminder, for example where to check in.">
          <TextArea value={note} onChange={(e) => onNote(e.target.value)} maxLength={1000} rows={2} />
        </FormField>
      )}
    </div>
  );
}
