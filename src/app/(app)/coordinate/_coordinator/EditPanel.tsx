"use client";

import { useState } from "react";
import type { EditRow } from "@/domain/jobs/bulk-edit";
import { Button } from "@/ui/components/Button";
import { FormField, Input, Select, TextArea } from "@/ui/components/FormField";
import { Notice } from "@/ui/components/Notice";
import { dollars } from "@/ui/components/PayLabel";
import { Icon } from "@/ui/icons";
import { applyEditAction, previewEditAction, quickEditAction, type EditWire } from "./actions";
import { addPosition, changePositionType } from "./detail-summary";
import { RateRangeNotice, typedCents } from "./RateRangeNotice";
import { useCoordAction } from "./status";
import { useConflictGuard } from "./conflict-guard";
import type { RateRange } from "@/domain/jobs/rate";
import { useRowKeys } from "@/ui/use-row-keys";

type Position = { positionTypeId: string; count: number };
type Option = { id: string; name: string };

const check = "size-4.5 accent-accent";
const TIME = new Intl.DateTimeFormat("en-US", { timeZone: "America/Chicago", hour: "numeric", minute: "2-digit" });
const DAY = new Intl.DateTimeFormat("en-US", { timeZone: "America/Chicago", weekday: "short", month: "short", day: "numeric" });

/** The rows of positions with Add position (agency default, merging duplicates) and Remove. */
export function PositionsEditor({ value, onChange, types, defaultTypeId, idPrefix }: Readonly<{ value: Position[]; onChange: (v: Position[]) => void; types: Option[]; defaultTypeId: string; idPrefix: string }>) {
  const keys = useRowKeys(value);
  return (
    <div className="flex flex-col gap-2">
      {value.map((p, i) => (
        <div key={keys[i]} className="grid grid-cols-[minmax(0,1fr)_5.5rem_auto] items-end gap-2">
          <FormField label={`Position ${i + 1}`}>
            <Select value={p.positionTypeId} onChange={(e) => onChange(changePositionType(value, i, e.target.value))}>
              {types.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </Select>
          </FormField>
          <FormField label="Count">
            <Input type="number" inputMode="numeric" min={1} max={99} value={p.count} onChange={(e) => onChange(value.map((x, j) => (j === i ? { ...x, count: Number(e.target.value) } : x)))} />
          </FormField>
          <Button variant="secondary" size="sm" disabled={value.length === 1} onClick={() => onChange(value.filter((_, j) => j !== i))} aria-label={`Remove position ${i + 1}`}>
            Remove
          </Button>
        </div>
      ))}
      <AddPositionRow types={types} defaultTypeId={defaultTypeId} onAdd={(typeId) => onChange(addPosition(value, typeId))} idPrefix={idPrefix} />
    </div>
  );
}

/**
 * Add position: a type picker that starts on the agency default type, and Add. A type already listed raises
 * that row's count instead of adding a second row.
 */
export function AddPositionRow({ types, defaultTypeId, onAdd, idPrefix }: Readonly<{ types: Option[]; defaultTypeId: string; onAdd: (typeId: string) => void; idPrefix: string }>) {
  const [typeId, setTypeId] = useState(defaultTypeId);
  return (
    <div className="flex flex-wrap items-end gap-2">
      <FormField label="Position to add">
        <Select id={`${idPrefix}-add-type`} value={typeId} onChange={(e) => setTypeId(e.target.value)} className="min-w-48">
          {types.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </Select>
      </FormField>
      <Button variant="secondary" onClick={() => onAdd(typeId)}>
        <Icon name="plus" size={16} />
        Add position
      </Button>
    </div>
  );
}

/**
 * Deputy conflicts a time change would cause, with the two ways out (remove the deputy from the detail, or change
 * the edit) and an override that needs a confirmation and a reason. `reason` is sent only once confirmed.
 */
export function ConflictOverride({ conflicts, confirmed, onConfirmed, reason, onReason, idPrefix }: Readonly<{ conflicts: string[]; confirmed: boolean; onConfirmed: (v: boolean) => void; reason: string; onReason: (v: string) => void; idPrefix: string }>) {
  if (conflicts.length === 0) return null;
  return (
    <div className="flex flex-col gap-2.5" data-testid={`${idPrefix}-conflicts`}>
      <Notice tone="danger" as="div">
        <strong className="font-semibold">
          {conflicts.length === 1 ? "This change double-books or overloads a deputy." : `This change double-books or overloads deputies (${conflicts.length}).`}
        </strong>
        <ul className="m-0 mt-1 list-disc pl-5">
          {conflicts.map((c) => (
            <li key={c}>{c}</li>
          ))}
        </ul>
        Remove the deputy from the detail under Staffing, change the edit, or override below.
      </Notice>
      <label className="flex min-h-11 items-center gap-2 text-sm font-medium">
        <input type="checkbox" checked={confirmed} onChange={(e) => onConfirmed(e.target.checked)} className={check} />Save anyway: I confirm these deputies stay on with the conflicts above
      </label>
      {confirmed ? (
        <FormField label="Reason for the override" hint="Required. Kept in the audit log with the deputies and conflicts.">
          <TextArea id={`${idPrefix}-conflict-reason`} value={reason} onChange={(e) => onReason(e.target.value)} maxLength={500} rows={2} required />
        </FormField>
      ) : null}
    </div>
  );
}

const samePositions = (a: Position[], b: Position[]) => JSON.stringify(a.map((p) => [p.positionTypeId, Number(p.count)])) === JSON.stringify(b.map((p) => [p.positionTypeId, Number(p.count)]));

export type QuickEditInitial = { rate: string; startTime: string; endTime: string; description: string; positions: Position[] };

/**
 * Quick edit on the detail page: rate, start and end time, positions and description in place, saved together.
 * On a series it applies to this detail or to this and the later ones; times apply on each detail's own date.
 */
export function QuickEdit({ jobId, initial, types, defaultTypeId, seriesLater, started, range, approved }: Readonly<{ jobId: string; initial: QuickEditInitial; types: Option[]; defaultTypeId: string; seriesLater: number; started: boolean; range: RateRange; approved: boolean }>) {
  const [v, setV] = useState(initial);
  const [scope, setScope] = useState<"one" | "series">("one");
  const [reason, setReason] = useState("");
  const { run, busy, error } = useCoordAction();
  const guard = useConflictGuard(error);
  // Only a time change can alter the deputy conflicts: it hides the shown list and drops the override.
  const change = (next: QuickEditInitial) => {
    if (next.startTime !== v.startTime || next.endTime !== v.endTime) guard.touch();
    setV(next);
  };
  const edit: EditWire = {};
  if (v.rate !== initial.rate) edit.rate = v.rate;
  if (!started && v.startTime !== initial.startTime) edit.startTime = v.startTime;
  if (!started && v.endTime !== initial.endTime) edit.endTime = v.endTime;
  if (v.description !== initial.description) edit.description = v.description;
  if (!samePositions(v.positions, initial.positions)) edit.positions = v.positions;
  if (reason.trim()) edit.rateOverrideReason = reason;
  if (guard.override) edit.conflictOverride = guard.override;
  const changed = Object.keys(edit).some((k) => k !== "rateOverrideReason" && k !== "conflictOverride");
  return (
    <form
      aria-label="Quick edit"
      className="flex flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        guard.submitted();
        run(
          () => quickEditAction({ jobId, scope, edit }),
          () => {
            setReason("");
            guard.reset();
          },
        );
      }}
    >
      {seriesLater > 1 ? (
        <fieldset className="m-0 flex flex-col gap-0.5 border-0 p-0">
          <legend className="mb-1 text-sm font-medium text-muted">Save to</legend>
          <label className="flex min-h-11 items-center gap-2">
            <input type="radio" name="quick-scope" checked={scope === "one"} onChange={() => {
                setScope("one");
                guard.touch();
              }} className={check} />This detail only
          </label>
          <label className="flex min-h-11 items-center gap-2">
            <input type="radio" name="quick-scope" checked={scope === "series"} onChange={() => {
                setScope("series");
                guard.touch();
              }} className={check} />
            This and later details in the series ({seriesLater})
          </label>
        </fieldset>
      ) : null}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <FormField label="Rate per hour">
          <Input inputMode="decimal" value={v.rate} onChange={(e) => change({ ...v, rate: e.target.value })} required />
        </FormField>
        <FormField label="Start time" hint={started ? "Started" : undefined}>
          <Input type="time" value={v.startTime} onChange={(e) => change({ ...v, startTime: e.target.value })} disabled={started} required />
        </FormField>
        <FormField label="End time">
          <Input type="time" value={v.endTime} onChange={(e) => change({ ...v, endTime: e.target.value })} disabled={started} required />
        </FormField>
      </div>
      <RateRangeNotice rateCents={typedCents(v.rate)} range={range} reason={reason} onReason={setReason} canApprove={scope === "one"} approved={approved && v.rate === initial.rate} />
      <div className="flex flex-col gap-1.5">
        <span className="text-sm font-medium text-muted">Positions</span>
        <PositionsEditor value={v.positions} onChange={(positions) => change({ ...v, positions })} types={types} defaultTypeId={defaultTypeId} idPrefix="quick" />
      </div>
      <FormField label="Description">
        <TextArea value={v.description} onChange={(e) => change({ ...v, description: e.target.value })} maxLength={4000} rows={3} />
      </FormField>
      <p className="m-0 text-xs text-muted">People on the detail are alerted when the rate, times, positions or description change.</p>
      <ConflictOverride {...guard.props} idPrefix="quick" />
      <div className="flex flex-wrap gap-2">
        <Button type="submit" busy={busy} disabled={!changed || (guard.conflicts.length > 0 && guard.confirmed && !guard.override)}>
          {guard.override ? "Save with override" : "Save changes"}
        </Button>
        {changed ? (
          <Button type="button" variant="secondary" onClick={() => change(initial)}>
            Undo changes
          </Button>
        ) : null}
      </div>
    </form>
  );
}

function Shot({ s }: Readonly<{ s: { startAt: string; endAt: string; rateCents: number; description: string | null; positions: Array<{ name: string; count: number }> } }>) {
  return (
    <span className="flex flex-col text-sm">
      <span data-numeric>
        {TIME.format(new Date(s.startAt))} to {TIME.format(new Date(s.endAt))}, {dollars(s.rateCents)}/hr
      </span>
      <span className="text-muted">{s.positions.map((p) => `${p.count} ${p.name}`).join(", ")}</span>
    </span>
  );
}

type WireRow = Omit<EditRow, "before" | "after" | "conflicts"> & {
  conflictFingerprint: string | null;
  conflicts: Array<{ assignmentId: string; name: string; check: string; message: string }>; before: Parameters<typeof Shot>[0]["s"]; after: Parameters<typeof Shot>[0]["s"] | null };

/** One detail in the bulk edit preview: before and after, and why it is refused or which deputies conflict. */
function PreviewRow({ r }: Readonly<{ r: WireRow }>) {
  return (
    <li className="flex flex-col gap-1.5 px-3 py-2.5">
      <span className="font-semibold">
        #{r.number} {r.title}
        <span className="font-normal text-muted">
          , {r.vendorName}, {DAY.format(new Date(r.before.startAt))}
        </span>
      </span>
      <div className="grid gap-2 sm:grid-cols-2">
        <div className="flex flex-col">
          <span className="text-xs font-semibold text-muted">Before</span>
          <Shot s={r.before} />
        </div>
        {r.after ? (
          <div className="flex flex-col">
            <span className="text-xs font-semibold text-muted">After</span>
            <Shot s={r.after} />
          </div>
        ) : null}
      </div>
      {r.problem ? <p className="m-0 text-sm font-medium text-danger-ink">Refused: {r.problem}</p> : null}
      {r.conflicts.map((c) => (
        <p key={`${c.assignmentId}-${c.check}`} className="m-0 text-sm font-medium text-danger-ink">
          Conflict for {c.name}: {c.message}{" "}
          <a href={`/jobs/${r.jobId}?tab=manage`} target="_blank" rel="noreferrer" className="font-semibold">
            Open the detail in a new tab to remove them
          </a>
        </p>
      ))}
    </li>
  );
}

/** The bulk edit preview: refusals, every detail's before and after, the conflict override and Save all. */
function BulkPreview({
  preview,
  conflicts,
  confirmed,
  onConfirmed,
  reason,
  onReason,
  busy,
  count,
  onSave,
}: Readonly<{
  preview: WireRow[];
  conflicts: string[];
  confirmed: boolean;
  onConfirmed: (v: boolean) => void;
  reason: string;
  onReason: (v: string) => void;
  busy: boolean;
  count: number;
  onSave: () => void;
}>) {
  const refused = preview.filter((r) => r.problem).length;
  return (
    <div className="flex flex-col gap-2.5">
      <h3 className="m-0 text-body font-semibold">Preview</h3>
      {refused ? <Notice tone="danger">{refused === 1 ? "1 detail cannot take this change" : `${refused} details cannot take this change`}. Remove them from the selection or change the edit; nothing is saved until every detail can.</Notice> : null}
      <ul className="m-0 flex max-h-112 list-none flex-col divide-y divide-divider overflow-y-auto rounded-md border border-line p-0" aria-label="Before and after">
        {preview.map((r) => (
          <PreviewRow key={r.jobId} r={r} />
        ))}
      </ul>
      <ConflictOverride conflicts={conflicts} confirmed={confirmed} onConfirmed={onConfirmed} reason={reason} onReason={onReason} idPrefix="bulk" />
      <Button busy={busy} disabled={refused > 0 || (conflicts.length > 0 && !(confirmed && reason.trim()))} onClick={onSave} className="w-fit">
        {count === 1 ? "Save 1 detail" : `Save all ${count} details`}
      </Button>
    </div>
  );
}

/**
 * Bulk edit for selected details (any vendor): blank fields stay as they are. Preview lists every detail's before
 * and after and any refusal; Save all saves every detail or none.
 */
export function BulkEdit({ jobIds, types, defaultTypeId, onDone }: Readonly<{ jobIds: string[]; types: Option[]; defaultTypeId: string; onDone: () => void }>) {
  const [rate, setRate] = useState("");
  const [startTime, setStart] = useState("");
  const [endTime, setEnd] = useState("");
  const [changeDescription, setChangeDescription] = useState(false);
  const [description, setDescription] = useState("");
  const [changePositions, setChangePositions] = useState(false);
  const [positions, setPositions] = useState<Position[]>([{ positionTypeId: defaultTypeId, count: 1 }]);
  const [preview, setPreview] = useState<WireRow[] | null>(null);
  /** Why the last save was refused after a preview; the old preview is dropped until a new one runs. */
  const [stale, setStale] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [conflictReason, setConflictReason] = useState("");
  const { run, busy } = useCoordAction();
  const edit: EditWire = {};
  if (rate.trim()) edit.rate = rate;
  if (startTime) edit.startTime = startTime;
  if (endTime) edit.endTime = endTime;
  if (changeDescription) edit.description = description;
  if (changePositions) edit.positions = positions;
  const any = Object.keys(edit).length > 0;
  const conflicts = (preview ?? []).flatMap((r) => r.conflicts.map((c) => `${c.name} on #${r.number}, ${DAY.format(new Date(r.before.startAt))}: ${c.message}`));
  const fingerprints = Object.fromEntries((preview ?? []).filter((r) => r.conflictFingerprint).map((r) => [r.jobId, r.conflictFingerprint!]));
  const saveEdit: EditWire = conflicts.length && confirmed && conflictReason.trim() ? { ...edit, conflictOverride: { reason: conflictReason, fingerprints } } : edit;
  const touch = <T,>(fn: (x: T) => void) => (x: T) => {
    fn(x);
    setPreview(null);
    setConfirmed(false);
  };
  return (
    <form
      aria-label="Bulk edit"
      className="flex flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        run(
          () => previewEditAction({ jobIds, edit }),
          (r) => {
            setStale(null);
            setPreview(JSON.parse(r.value ?? "[]"));
          },
          { refresh: false, quiet: true },
        );
      }}
    >
      <p className="m-0 text-sm text-muted">Leave a field blank to keep each detail&apos;s own value. Times apply on each detail&apos;s own date.</p>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <FormField label="New rate per hour">
          <Input inputMode="decimal" value={rate} onChange={(e) => touch(setRate)(e.target.value)} placeholder="Keep" />
        </FormField>
        <FormField label="New start time">
          <Input type="time" value={startTime} onChange={(e) => touch(setStart)(e.target.value)} />
        </FormField>
        <FormField label="New end time">
          <Input type="time" value={endTime} onChange={(e) => touch(setEnd)(e.target.value)} />
        </FormField>
      </div>
      <label className="flex min-h-11 items-center gap-2">
        <input type="checkbox" checked={changePositions} onChange={(e) => touch(setChangePositions)(e.target.checked)} className={check} />Replace the positions
      </label>
      {changePositions ? <PositionsEditor value={positions} onChange={touch(setPositions)} types={types} defaultTypeId={defaultTypeId} idPrefix="bulk" /> : null}
      <label className="flex min-h-11 items-center gap-2">
        <input type="checkbox" checked={changeDescription} onChange={(e) => touch(setChangeDescription)(e.target.checked)} className={check} />Replace the description
      </label>
      {changeDescription ? (
        <FormField label="Description">
          <TextArea value={description} onChange={(e) => touch(setDescription)(e.target.value)} maxLength={4000} rows={3} />
        </FormField>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" variant={preview ? "secondary" : "primary"} busy={busy} disabled={!any}>
          Preview changes
        </Button>
        <Button type="button" variant="secondary" onClick={onDone}>
          Close
        </Button>
      </div>
      {stale && !preview ? (
        <div data-testid="bulk-stale">
          <Notice tone="warning" as="div">
            <strong className="font-semibold">Nothing was saved.</strong> {stale} Preview the changes again to see the details and any conflicts as they are now.
          </Notice>
        </div>
      ) : null}
      {preview ? (
        <BulkPreview
          preview={preview}
          conflicts={conflicts}
          confirmed={confirmed}
          onConfirmed={setConfirmed}
          reason={conflictReason}
          onReason={setConflictReason}
          busy={busy}
          count={jobIds.length}
          onSave={() =>
            run(async () => {
              const r = await applyEditAction({ jobIds, edit: saveEdit });
              if (!r.ok) {
                // The details changed since the preview: drop it so nothing stale is shown or overridden.
                setPreview(null);
                setConfirmed(false);
                setConflictReason("");
                setStale(r.error);
              }
              return r;
            }, onDone)
          }
        />
      ) : null}
    </form>
  );
}
