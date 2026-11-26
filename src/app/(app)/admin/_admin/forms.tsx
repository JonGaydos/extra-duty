"use client";

import { useId, useState } from "react";
import { Button } from "@/ui/components/Button";
import { FormField, Input, Select, TextArea } from "@/ui/components/FormField";
import { PhoneField } from "@/ui/components/PhoneField";
import type { ActionResult } from "../../_personnel/result";
import { useCoordAction } from "../../coordinate/_coordinator/status";
import { WEEKDAYS, type Field, type GroupValues } from "./settings-groups";

/** A labeled on/off switch (DESIGN: a button with role="switch" and a visible label). */
export function Switch({ label, hint, checked, onChange }: Readonly<{ label: string; hint?: string; checked: boolean; onChange: (v: boolean) => void }>) {
  const id = useId();
  return (
    <div className="flex items-center justify-between gap-3 rounded-md border border-line bg-surface px-3.5 py-1.5">
      <span className="flex flex-col">
        <span id={`${id}-label`} className="font-medium">
          {label}
        </span>
        {hint ? (
          <span id={`${id}-hint`} className="text-xs text-muted">
            {hint}
          </span>
        ) : null}
      </span>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-labelledby={`${id}-label`}
        aria-describedby={hint ? `${id}-hint` : undefined}
        onClick={() => onChange(!checked)}
        className="flex h-11 shrink-0 items-center"
      >
        <span className={`relative inline-flex h-4.5 w-7.5 rounded-full transition-colors duration-150 ${checked ? "bg-accent" : "bg-field"}`}>
          <span className={`absolute top-0.5 size-3.5 rounded-full bg-surface transition-[left] duration-150 ${checked ? "left-3.5" : "left-0.5"}`} />
        </span>
      </button>
    </div>
  );
}

/** A checkbox row with its label; 44 px tall so it is easy to hit. */
export function Check({ label, checked, onChange, hint, disabled = false }: Readonly<{ label: string; checked: boolean; onChange: (v: boolean) => void; hint?: string; disabled?: boolean }>) {
  return (
    <label className={`flex min-h-11 items-center gap-2.5 text-body ${disabled ? "cursor-not-allowed text-muted" : "cursor-pointer"}`}>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} className="size-4.5 shrink-0 accent-accent" />
      <span className="flex flex-col">
        <span>{label}</span>
        {hint ? <span className="text-xs text-muted">{hint}</span> : null}
      </span>
    </label>
  );
}

/** A group of checkboxes for picking several of a list. */
export function CheckGroup({ legend, options, value, onChange, error }: Readonly<{ legend: string; options: Array<{ id: string; name: string }>; value: string[]; onChange: (v: string[]) => void; error?: string }>) {
  const id = useId();
  return (
    <fieldset className="m-0 flex flex-col gap-1 border-0 p-0" aria-describedby={error ? `${id}-error` : undefined}>
      <legend className="mb-1 p-0 text-sm font-medium text-muted">{legend}</legend>
      <div className="grid gap-x-4 sm:grid-cols-2">
        {options.map((o) => (
          <Check key={o.id} label={o.name} checked={value.includes(o.id)} onChange={(on) => onChange(on ? [...value, o.id] : value.filter((x) => x !== o.id))} />
        ))}
      </div>
      {error ? (
        <p id={`${id}-error`} className="m-0 text-xs font-medium text-danger-ink">
          {error}
        </p>
      ) : null}
    </fieldset>
  );
}

const INPUT_MODE: Partial<Record<Field["kind"], React.HTMLAttributes<HTMLInputElement>["inputMode"]>> = { int: "numeric", float: "decimal", dollars: "decimal", dollarsOptional: "decimal", hours: "decimal" };
const INPUT_TYPE: Partial<Record<Field["kind"], string>> = { time: "time", date: "date", email: "email" };
const NUMERIC_KINDS = new Set<Field["kind"]>(["int", "float", "hours", "dollars", "dollarsOptional"]);
const NARROW_KINDS = new Set<Field["kind"]>(["int", "hours", "dollars", "dollarsOptional"]);

type Choices = Partial<Record<Field["kind"], Array<{ id: string; name: string }>>>;
type SetValue = (k: string, v: GroupValues[string]) => void;

/** The choices of a select field: position types from the database, the weekdays, or the field's own list. */
function selectOptions(f: Field, options: Choices): React.ReactNode {
  if (f.kind === "positionType")
    return (options.positionType ?? []).map((o) => (
      <option key={o.id} value={o.id}>
        {o.name}
      </option>
    ));
  return (f.kind === "weekday" ? WEEKDAYS : (f.options ?? [])).map(([val, label]) => (
    <option key={val} value={val}>
      {label}
    </option>
  ));
}

/**
 * The control inside a field's FormField. A plain function, not a component, so FormField gets the control
 * element itself to wire its id and descriptions.
 */
function fieldControl(f: Field, v: GroupValues[string], set: SetValue, options: Choices) {
  if (f.kind === "select" || f.kind === "weekday" || f.kind === "positionType")
    return (
      <Select value={String(v)} onChange={(e) => set(f.key, e.target.value)}>
        {selectOptions(f, options)}
      </Select>
    );
  if (f.kind === "phone") return <PhoneField value={String(v)} onValue={(nv) => set(f.key, nv)} className="md:max-w-60" />;
  if (f.kind === "textarea") return <TextArea value={String(v)} onChange={(e) => set(f.key, e.target.value)} maxLength={4000} />;
  return (
    <Input
      type={INPUT_TYPE[f.kind] ?? "text"}
      inputMode={INPUT_MODE[f.kind]}
      value={String(v)}
      onChange={(e) => set(f.key, e.target.value)}
      data-numeric={NUMERIC_KINDS.has(f.kind) ? true : undefined}
      className={NARROW_KINDS.has(f.kind) ? "md:max-w-48" : undefined}
    />
  );
}

/** One field of a settings form: a switch, the reviewer checkboxes, or a labeled control. */
function SettingField({ f, v, err, set, options }: Readonly<{ f: Field; v: GroupValues[string]; err: string | undefined; set: SetValue; options: Choices }>) {
  if (f.kind === "switch") return <Switch label={f.label} hint={f.hint} checked={v === true} onChange={(on) => set(f.key, on)} />;
  if (f.kind === "reviewers")
    return (
      <>
        <CheckGroup legend={f.label} options={options.reviewers ?? []} value={Array.isArray(v) ? v : []} onChange={(ids) => set(f.key, ids)} error={err} />
        {f.hint ? <p className="m-0 text-xs text-muted">{f.hint}</p> : null}
      </>
    );
  return (
    <FormField label={f.label} hint={f.hint} error={err}>
      {fieldControl(f, v, set, options)}
    </FormField>
  );
}

/**
 * One settings group as a form: every field with its hint, one Save, and the server's field errors shown under
 * each field. The page's status line announces the result.
 */
export function SettingsForm({
  slug,
  fields,
  initial,
  save,
  saveLabel,
  options = {},
}: Readonly<{
  slug: string;
  fields: readonly Field[];
  initial: GroupValues;
  save: (slug: string, values: GroupValues) => Promise<ActionResult>;
  saveLabel: string;
  /** Choices for fields filled from the database (position types, reviewers). */
  options?: Choices;
}>) {
  const [values, setValues] = useState(initial);
  const { run, busy, error } = useCoordAction();
  const errors = error && !error.ok ? (error.fields ?? {}) : {};
  const set = (k: string, v: GroupValues[string]) => setValues((cur) => ({ ...cur, [k]: v }));
  return (
    <form
      noValidate
      aria-label={saveLabel.replace(/^Save /, "")}
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        run(() => save(slug, values));
      }}
    >
      <div className="grid gap-x-5 gap-y-4 md:grid-cols-2">
        {fields.map((f) => {
          const wide = f.kind === "textarea" || f.kind === "reviewers" || f.kind === "switch";
          return (
            <div key={f.key} className={wide ? "md:col-span-2" : undefined}>
              <SettingField f={f} v={values[f.key]} err={errors[f.key]} set={set} options={options} />
            </div>
          );
        })}
      </div>
      <Button type="submit" busy={busy} className="w-full md:w-fit">
        {saveLabel}
      </Button>
    </form>
  );
}
