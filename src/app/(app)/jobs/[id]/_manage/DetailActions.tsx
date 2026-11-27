"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import type { DetailFormOptions } from "@/domain/coordinator/views";
import { Button, ButtonLink } from "@/ui/components/Button";
import { Card, CardTitle } from "@/ui/components/Card";
import { FormField, Input, Select, TextArea } from "@/ui/components/FormField";
import { Notice } from "@/ui/components/Notice";
import {
  approveRequestAction,
  assignAction,
  cancelDetailAction,
  copyDetailAction,
  decideChangeAction,
  declineRequestAction,
  nameIcAction,
  reactivateDetailAction,
  noShowAction,
  holdDetailAction,
  releaseDetailAction,
  removeAction,
  repeatDetailAction,
  reviewOpsPlanAction,
  saveSafetyAction,
  updateDetailAction,
  waiveLateCancelAction,
} from "../../../coordinate/_coordinator/actions";
import { DatesStep } from "../../../coordinate/_coordinator/DatesStep";
import { SafetyAddressFields, safetyRows, safetyWire, type SafetyAddressWire } from "../../../coordinate/_coordinator/DetailFields";
import type { DetailWire } from "../../../coordinate/_coordinator/detail-input";
import { RateRangeNotice, typedCents } from "../../../coordinate/_coordinator/RateRangeNotice";
import { useCoordAction } from "../../../coordinate/_coordinator/status";
import { SiteContactFields } from "../../../coordinate/_coordinator/SiteContactFields";
import { ConflictOverride, PositionsEditor } from "../../../coordinate/_coordinator/EditPanel";
import { clearsConflicts, useConflictGuard } from "../../../coordinate/_coordinator/conflict-guard";

const check = "size-4.5 accent-accent";

export function RequestDecision({ jobId, dates }: Readonly<{ jobId: string; dates: number }>) {
  const [declining, setDeclining] = useState(false);
  const [reason, setReason] = useState("");
  const { run, busy } = useCoordAction();
  return (
    <div className="flex flex-col gap-3">
      {declining ? (
        <form
          className="flex flex-col gap-2.5"
          onSubmit={(e) => {
            e.preventDefault();
            run(() => declineRequestAction({ jobId, reason }));
          }}
        >
          <FormField label="Reason for the vendor">
            <TextArea value={reason} onChange={(e) => setReason(e.target.value)} required maxLength={1000} />
          </FormField>
          <div className="flex flex-wrap gap-2">
            <Button type="submit" variant="danger" busy={busy}>
              Decline request
            </Button>
            <Button type="button" variant="secondary" onClick={() => setDeclining(false)}>
              Back
            </Button>
          </div>
        </form>
      ) : (
        <div className="flex flex-wrap gap-2">
          <Button busy={busy} onClick={() => run(() => approveRequestAction(jobId))}>
            Approve request
          </Button>
          <Button variant="secondary" onClick={() => setDeclining(true)}>
            Decline
          </Button>
        </div>
      )}
      <p className="m-0 text-xs text-muted">{dates > 1 ? `Applies to all ${dates} dates in the request. ` : ""}Edit the detail first to approve it with changes.</p>
    </div>
  );
}

/** Approve or decline a vendor's change. A time change that double-books or overloads a deputy lists the conflicts and needs a resolve or an override. */
export function ChangeDecision({ requestId, jobId }: Readonly<{ requestId: string; jobId: string }>) {
  const [declining, setDeclining] = useState(false);
  const [reason, setReason] = useState("");
  const { run, busy, error } = useCoordAction();
  const guard = useConflictGuard(error);
  if (declining)
    return (
      <form
        className="flex flex-col gap-2.5"
        onSubmit={(e) => {
          e.preventDefault();
          run(() => decideChangeAction({ requestId, approve: false, reason }));
        }}
      >
        <FormField label="Reason for the vendor">
          <Input value={reason} onChange={(e) => setReason(e.target.value)} required maxLength={1000} />
        </FormField>
        <div className="flex gap-2">
          <Button type="submit" size="sm" variant="danger" busy={busy}>
            Decline change
          </Button>
          <Button type="button" size="sm" variant="secondary" onClick={() => setDeclining(false)}>
            Back
          </Button>
        </div>
      </form>
    );
  return (
    <div className="flex flex-col gap-2.5">
      <ConflictOverride {...guard.props} idPrefix={`change-${requestId}`} />
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          busy={busy}
          disabled={guard.conflicts.length > 0 && guard.confirmed && !guard.override}
          onClick={() => {
            guard.submitted();
            run(() => decideChangeAction({ requestId, approve: true, reason: "", jobId, ...(guard.override ? { conflictOverride: guard.override } : {}) }), guard.reset);
          }}
        >
          {guard.override ? "Approve with override" : "Approve change"}
        </Button>
        <Button size="sm" variant="secondary" onClick={() => setDeclining(true)}>
          Decline
        </Button>
      </div>
    </div>
  );
}

/** The editor, behind "Edit detail". On a series, Apply to chooses this detail or this and the later ones. */
export function EditDetail({ jobId, initial, date, options, seriesLater, started, approved = false }: Readonly<{ jobId: string; initial: DetailWire; date: string; options: DetailFormOptions; seriesLater: number; started: boolean; approved?: boolean }>) {
  const [open, setOpen] = useState(false);
  const [d, setD] = useState(initial);
  const [day, setDay] = useState(date);
  const [scope, setScope] = useState<"one" | "series">("one");
  const { run, busy, error } = useCoordAction();
  const guard = useConflictGuard(error);
  // Only a change that can alter the deputy conflicts (times, flexible window, date, scope) makes the listed
  // conflicts stale; those hide the list and drop the override. Rate, text and the like leave it in place.
  const set = <K extends keyof DetailWire>(k: K, v: DetailWire[K]) => {
    setD((x) => ({ ...x, [k]: v }));
    if (clearsConflicts(k)) guard.touch();
  };
  const locations = options.locations.filter((l) => l.vendorId === d.vendorId);
  if (!open)
    return (
      <Button variant="secondary" onClick={() => setOpen(true)} aria-expanded={false} className="w-fit">
        Edit detail
      </Button>
    );
  return (
    <Card tone="accent" as="div">
      <CardTitle>Edit detail</CardTitle>
      <form
        aria-label="Edit detail"
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          guard.submitted();
          run(() => updateDetailAction({ jobId, detail: d, date: day, scope, ...(guard.override ? { conflictOverride: guard.override } : {}) }), () => {
            guard.reset();
            setOpen(false);
          });
        }}
      >
        {seriesLater > 1 ? (
          <fieldset className="m-0 flex flex-col gap-1 border-0 p-0">
            <legend className="mb-1 text-sm font-medium text-muted">Apply to</legend>
            <label className="flex min-h-11 items-center gap-2">
              <input type="radio" name="scope" checked={scope === "one"} onChange={() => {
                setScope("one");
                guard.touch();
              }} className={check} />This detail only
            </label>
            <label className="flex min-h-11 items-center gap-2">
              <input type="radio" name="scope" checked={scope === "series"} onChange={() => {
                setScope("series");
                guard.touch();
              }} className={check} />
              This and later details in the series ({seriesLater})
            </label>
            {scope === "series" ? <p className="m-0 text-xs text-muted">Dates and times change one detail at a time.</p> : null}
          </fieldset>
        ) : null}
        <div className="grid gap-3 sm:grid-cols-2">
          <FormField label="Title">
            <Input value={d.title} onChange={(e) => set("title", e.target.value)} required maxLength={200} />
          </FormField>
          <FormField label="Location">
            <Select value={d.locationId} onChange={(e) => set("locationId", e.target.value)}>
              <option value="">No set location</option>
              {locations.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </Select>
          </FormField>
          <FormField label="Type">
            <Select value={d.typeId} onChange={(e) => set("typeId", e.target.value)}>
              {options.types.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </Select>
          </FormField>
          <FormField label="Rate per hour" hint="Blank uses the vendor's default. People on the detail are alerted.">
            <Input inputMode="decimal" value={d.rate} onChange={(e) => set("rate", e.target.value)} />
          </FormField>
          <RateRangeNotice
            rateCents={typedCents(d.rate)}
            range={options.rateRange}
            reason={d.rateOverrideReason ?? ""}
            onReason={(v) => set("rateOverrideReason", v)}
            canApprove={scope === "one"}
            approved={approved && d.rate === initial.rate}
          />
        </div>
        {scope === "one" && !started ? (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            <FormField label="Date">
              <Input type="date" value={day} onChange={(e) => {
                  setDay(e.target.value);
                  guard.touch();
                }} required />
            </FormField>
            <FormField label="Start time">
              <Input type="time" value={d.startTime} onChange={(e) => set("startTime", e.target.value)} required />
            </FormField>
            <FormField label="End time">
              <Input type="time" value={d.endTime} onChange={(e) => set("endTime", e.target.value)} required />
            </FormField>
          </div>
        ) : null}
        <FormField label="Description">
          <TextArea value={d.description} onChange={(e) => set("description", e.target.value)} maxLength={4000} />
        </FormField>
        <div className="flex flex-col gap-2">
          <span className="text-sm font-medium text-muted">Positions</span>
          <PositionsEditor value={d.positions} onChange={(v) => set("positions", v)} types={options.positionTypes} defaultTypeId={options.defaultPositionTypeId ?? options.positionTypes[0]?.id ?? ""} idPrefix="edit" />
        </div>
        <SiteContactFields
          contacts={options.contacts.filter((c) => c.vendorId === d.vendorId)}
          value={{ contactName: d.contactName, contactPhone: d.contactPhone, newContact: d.newContact ?? null }}
          onChange={(c) => setD((x) => ({ ...x, ...c }))}
        />
        <label className="flex min-h-11 items-center gap-2">
          <input type="checkbox" checked={d.opsPlanRequired} onChange={(e) => set("opsPlanRequired", e.target.checked)} className={check} />Ops plan required
        </label>
        <ConflictOverride {...guard.props} idPrefix="edit" />
        <div className="flex flex-wrap gap-2">
          <Button type="submit" busy={busy} disabled={guard.conflicts.length > 0 && guard.confirmed && !guard.override}>
            {guard.override ? "Save with override" : "Save changes"}
          </Button>
          <Button type="button" variant="secondary" onClick={() => setOpen(false)}>
            Close
          </Button>
        </div>
      </form>
    </Card>
  );
}

export function SafetyEditor({ jobId, notes, addresses }: Readonly<{ jobId: string; notes: string; addresses: SafetyAddressWire[] }>) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState(notes);
  const [list, setList] = useState(() => safetyRows(addresses));
  const { run, busy } = useCoordAction();
  if (!open)
    return (
      <Button size="sm" variant="secondary" className="w-fit" onClick={() => setOpen(true)}>
        {notes || addresses.length ? "Edit officer safety" : "Add officer safety"}
      </Button>
    );
  return (
    <form
      aria-label="Officer safety"
      className="flex flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        run(() => saveSafetyAction({ jobId, notes: text, addresses: safetyWire(list) }), () => setOpen(false));
      }}
    >
      <FormField label="Safety notes">
        <TextArea value={text} onChange={(e) => setText(e.target.value)} maxLength={4000} />
      </FormField>
      <SafetyAddressFields addresses={list} onAddresses={setList} />
      <div className="flex flex-wrap gap-2">
        <Button type="submit" size="sm" busy={busy}>
          Save officer safety
        </Button>
        <Button type="button" size="sm" variant="secondary" onClick={() => setOpen(false)}>
          Close
        </Button>
      </div>
      <p className="m-0 text-xs text-muted">People on the detail are alerted when this changes.</p>
    </form>
  );
}

type Person = { id: string; name: string };

/** Puts someone in a position. Failing rules need an override reason; a vendor restriction never does. */
export function AssignForm({ positions, people }: Readonly<{ positions: Array<{ id: string; name: string; open: number }>; people: Person[] }>) {
  const [open, setOpen] = useState(false);
  const [positionId, setPositionId] = useState(positions.find((p) => p.open > 0)?.id ?? positions[0]?.id ?? "");
  const [userId, setUserId] = useState("");
  const [override, setOverride] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [notify, setNotify] = useState(true);
  const { run, busy, error } = useCoordAction();
  if (!open)
    return (
      <Button size="sm" variant="secondary" className="w-fit" onClick={() => setOpen(true)}>
        Assign someone
      </Button>
    );
  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        run(() => assignAction({ jobPositionId: positionId, userId, overrideReason: confirmed ? override : "", notify }), () => setOpen(false));
      }}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <FormField label="Position">
          <Select value={positionId} onChange={(e) => setPositionId(e.target.value)}>
            {positions.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} ({p.open} open)
              </option>
            ))}
          </Select>
        </FormField>
        <FormField label="Person">
          <Select value={userId} onChange={(e) => setUserId(e.target.value)} required>
            <option value="">Choose a person</option>
            {people.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </Select>
        </FormField>
      </div>
      {error && !error.ok && error.checks?.length ? (
        <>
          <Notice tone="danger" as="div">
            <strong className="font-semibold">This placement breaks these rules:</strong>
            <ul className="m-0 mt-1 list-disc pl-5">
              {error.checks.map((c) => (
                <li key={`${c.check}-${c.message}`}>{c.message}</li>
              ))}
            </ul>
          </Notice>
          <label className="flex min-h-11 items-center gap-2 text-sm font-medium">
            <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} className={check} />Assign anyway: I confirm overriding these rules
          </label>
          {confirmed ? (
            <FormField label="Override reason" hint="Required. Kept in the audit log with the rules it overrides. A vendor restriction cannot be overridden.">
              <Input value={override} onChange={(e) => setOverride(e.target.value)} maxLength={500} required />
            </FormField>
          ) : null}
        </>
      ) : null}
      <label className="flex min-h-11 items-center gap-2">
        <input type="checkbox" checked={notify} onChange={(e) => setNotify(e.target.checked)} className={check} />Tell the person
      </label>
      <div className="flex gap-2">
        <Button type="submit" size="sm" busy={busy}>
          Assign
        </Button>
        <Button type="button" size="sm" variant="secondary" onClick={() => setOpen(false)}>
          Close
        </Button>
      </div>
    </form>
  );
}

/** Remove, no-show and Incident Commander for one roster row. */
export function RosterRowActions({ assignmentId, jobId, userId, name, status, started, canNameIc }: Readonly<{ assignmentId: string; jobId: string; userId: string; name: string; status: string; started: boolean; canNameIc: boolean }>) {
  const [mode, setMode] = useState<"remove" | "noshow" | null>(null);
  const [text, setText] = useState("");
  const { run, busy } = useCoordAction();
  const active = status === "signed_up" || status === "backup" || status === "pending_short";
  if (!active) return null;
  if (mode)
    return (
      <form
        className="flex min-w-60 flex-col gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          run(() => (mode === "remove" ? removeAction({ assignmentId, comment: text }) : noShowAction({ assignmentId, note: text })));
        }}
      >
        <FormField label={mode === "remove" ? `Why remove ${name}` : `No-show note for ${name}`}>
          <Input value={text} onChange={(e) => setText(e.target.value)} required maxLength={500} />
        </FormField>
        <div className="flex gap-2">
          <Button type="submit" size="sm" variant={mode === "remove" ? "danger" : "primary"} busy={busy}>
            {mode === "remove" ? "Remove" : "Mark no-show"}
          </Button>
          <Button type="button" size="sm" variant="secondary" onClick={() => setMode(null)}>
            Back
          </Button>
        </div>
      </form>
    );
  return (
    <div className="flex flex-wrap gap-1.5">
      <Button size="sm" variant="secondary" onClick={() => setMode("remove")} aria-label={`Remove, ${name}`}>
        Remove
      </Button>
      {started && status === "signed_up" ? (
        <Button size="sm" variant="secondary" onClick={() => setMode("noshow")} aria-label={`No-show, ${name}`}>
          No-show
        </Button>
      ) : null}
      {canNameIc && status === "signed_up" ? (
        <Button size="sm" variant="secondary" busy={busy} onClick={() => run(() => nameIcAction({ jobId, userId }))} aria-label={`Name Incident Commander, ${name}`}>
          Name IC
        </Button>
      ) : null}
    </div>
  );
}

function copiesText(n: number): string {
  if (n === 0) return "Choose the dates to copy to.";
  return `${n} ${n === 1 ? "copy" : "copies"} at the same times.`;
}

/**
 * Copy to other dates as one new series. A copy carries the detail and its attachments (contract included), never
 * the people: each copy starts with an empty roster under the normal release rules.
 */
export function CopyDetail({ jobId, today, weekStartsOn }: Readonly<{ jobId: string; today: string; weekStartsOn: number }>) {
  const router = useRouter();
  const [dates, setDates] = useState<string[]>([]);
  const { run, busy } = useCoordAction();
  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        run(() => copyDetailAction({ jobId, dates }), (r) => r.value && router.push(`/jobs/${r.value}?tab=manage`), { refresh: false });
      }}
    >
      <DatesStep today={today} weekStartsOn={weekStartsOn} onDates={setDates} modes={["pick", "range"]} initial="pick" minDate={today} />
      <p className="m-0 text-sm text-muted" aria-live="polite">
        {copiesText(dates.length)}
      </p>
      <p className="m-0 max-w-[70ch] text-sm text-muted">Each copy brings the detail and its attachments, contract included. Nobody signed up here is copied; each copy opens with an empty roster.</p>
      <div className="flex flex-wrap gap-2">
        <Button type="submit" busy={busy} disabled={dates.length === 0}>
          {dates.length > 1 ? `Make ${dates.length} copies` : "Make copy"}
        </Button>
        <ButtonLink href={`/jobs/new?from=${jobId}`} variant="secondary">
          Copy and change details
        </ButtonLink>
      </div>
    </form>
  );
}

/** The repeat pattern for the chosen kind: weekly on the detail's weekday, monthly on its day of the month. */
function repeatRecurrence(kind: "daily" | "weekly" | "monthly", every: number, end: { count: number }, weekday: number, dayOfMonth: number) {
  if (kind === "daily") return { kind, every, end };
  if (kind === "weekly") return { kind, every, weekdays: [weekday], end };
  return { kind, every, dayOfMonth, end };
}

/** Adds later dates to this detail's series on a pattern. */
export function RepeatDetail({ jobId, weekday, dayOfMonth }: Readonly<{ jobId: string; weekday: number; dayOfMonth: number }>) {
  const [kind, setKind] = useState<"daily" | "weekly" | "monthly">("weekly");
  const [every, setEvery] = useState("1");
  const [count, setCount] = useState("4");
  const { run, busy } = useCoordAction();
  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        const n = Number(count) || 1;
        const end = { count: n + 1 };
        const ev = Number(every) || 1;
        run(() =>
          repeatDetailAction({
            jobId,
            recurrence: repeatRecurrence(kind, ev, end, weekday, dayOfMonth),
          }),
        );
      }}
    >
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <FormField label="Repeats">
          <Select value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>
            <option value="daily">Daily</option>
            <option value="weekly">Weekly</option>
            <option value="monthly">Monthly</option>
          </Select>
        </FormField>
        <FormField label="Every">
          <Input type="number" min={1} max={52} value={every} onChange={(e) => setEvery(e.target.value)} />
        </FormField>
        <FormField label="More dates">
          <Input type="number" min={1} max={365} value={count} onChange={(e) => setCount(e.target.value)} />
        </FormField>
      </div>
      <Button type="submit" variant="secondary" busy={busy} className="w-fit">
        Add to series
      </Button>
    </form>
  );
}

/** Why the detail is canceled, when it is not the agency's own choice. */
function cancelCause(locked: boolean, forVendor: boolean): "vendor_hold" | "vendor" | undefined {
  if (locked) return "vendor_hold";
  return forVendor ? "vendor" : undefined;
}

/** Cancel, with a required reason. A locked detail cancels as a hold cancellation; otherwise it may be canceled for the vendor. */
export function CancelDetail({ jobId, locked, latePayDefault }: Readonly<{ jobId: string; locked: boolean; latePayDefault: boolean }>) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState(locked ? "Vendor on payment hold" : "");
  const [forVendor, setForVendor] = useState(false);
  const [applyPay, setApplyPay] = useState(false);
  const { run, busy } = useCoordAction();
  // Late cancellation pay: fixed by a hold inside the window, chosen on a hold outside it, or "the vendor canceled".
  // A render function, so the choice keeps its place in the form.
  const payChoice = () => {
    if (locked && latePayDefault) return <Notice tone="warning">The hold came inside the late cancellation window, so the people signed up are paid the minimum.</Notice>;
    if (locked)
      return (
        <label className="flex min-h-11 items-center gap-2">
          <input type="checkbox" checked={applyPay} onChange={(e) => setApplyPay(e.target.checked)} className={check} />Pay the people signed up the late cancellation minimum
        </label>
      );
    return (
      <label className="flex min-h-11 items-center gap-2">
        <input type="checkbox" checked={forVendor} onChange={(e) => setForVendor(e.target.checked)} className={check} />The vendor canceled (late cancellation pay applies inside the window)
      </label>
    );
  };
  if (!open)
    return (
      <Button variant="danger" onClick={() => setOpen(true)} className="w-fit">
        Cancel detail
      </Button>
    );
  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        run(() => cancelDetailAction({ jobId, reason, cause: cancelCause(locked, forVendor), applyLateCancelPay: locked ? latePayDefault || applyPay : undefined }));
      }}
    >
      <FormField label="Reason" hint="Everyone on the detail is told.">
        <Input value={reason} onChange={(e) => setReason(e.target.value)} required maxLength={500} />
      </FormField>
      {payChoice()}
      <div className="flex gap-2">
        <Button type="submit" variant="danger" busy={busy}>
          Cancel detail
        </Button>
        <Button type="button" variant="secondary" onClick={() => setOpen(false)}>
          Keep it
        </Button>
      </div>
    </form>
  );
}

/**
 * One-button Hold and Release for a detail or, on a series, this and its later details. Release now appears while
 * the normal release time is still ahead. `status` is the current release state in words.
 */
export function HoldRelease({ jobId, held, opensLater, seriesLater, status }: Readonly<{ jobId: string; held: boolean; opensLater: boolean; seriesLater: number; status: string }>) {
  const [scope, setScope] = useState<"one" | "series">("one");
  const { run, busy } = useCoordAction();
  return (
    <div className="flex flex-col gap-2.5" aria-busy={busy}>
      <p className="m-0 text-sm text-muted" data-testid="release-state">
        {status}
      </p>
      {seriesLater > 1 ? (
        <fieldset className="m-0 flex flex-col gap-0.5 border-0 p-0">
          <legend className="mb-1 text-sm font-medium text-muted">Hold or release</legend>
          <label className="flex min-h-11 items-center gap-2">
            <input type="radio" name="hold-scope" checked={scope === "one"} onChange={() => setScope("one")} className={check} />This detail only
          </label>
          <label className="flex min-h-11 items-center gap-2">
            <input type="radio" name="hold-scope" checked={scope === "series"} onChange={() => setScope("series")} className={check} />
            This and later details in the series ({seriesLater})
          </label>
        </fieldset>
      ) : null}
      <div className="flex flex-wrap gap-2">
        {held ? (
          <Button variant="secondary" busy={busy} onClick={() => run(() => releaseDetailAction({ jobId, scope, now: false }))}>
            {opensLater ? "Release at the normal time" : "Release"}
          </Button>
        ) : (
          <Button variant="secondary" busy={busy} onClick={() => run(() => holdDetailAction({ jobId, scope }))}>
            Hold
          </Button>
        )}
        {opensLater ? (
          <Button variant="secondary" busy={busy} onClick={() => run(() => releaseDetailAction({ jobId, scope, now: true }))}>
            Release now
          </Button>
        ) : null}
      </div>
    </div>
  );
}

export function WaiveLateCancel({ jobId }: Readonly<{ jobId: string }>) {
  const [reason, setReason] = useState("");
  const { run, busy } = useCoordAction();
  return (
    <form
      className="flex flex-col gap-2.5"
      onSubmit={(e) => {
        e.preventDefault();
        run(() => waiveLateCancelAction({ jobId, reason }));
      }}
    >
      <FormField label="Reason to waive late cancellation pay">
        <Input value={reason} onChange={(e) => setReason(e.target.value)} required maxLength={500} />
      </FormField>
      <Button type="submit" variant="secondary" busy={busy} className="w-fit">
        Waive late cancellation pay
      </Button>
    </form>
  );
}

type Named = { userId: string; name: string };

/** Names as a sentence: "Ann", "Ann and Bo", "Ann, Bo and Cy". */
const names = (people: Named[]) => (people.length < 2 ? (people[0]?.name ?? "") : `${people.slice(0, -1).map((p) => p.name).join(", ")} and ${people.at(-1)!.name}`);

type Preview = { notify: Named[]; unbilled: Named[] };

/**
 * Brings a canceled detail back before it ends. The confirm step names who is told and whose late-cancel pay is
 * canceled, then takes a required reason that only staff see.
 */
export function ReactivateDetail({ jobId, preview }: Readonly<{ jobId: string; preview: Preview }>) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const { run, busy } = useCoordAction();
  if (!open)
    return (
      <Button onClick={() => setOpen(true)} aria-expanded={false} className="w-full md:w-fit">
        Reactivate detail
      </Button>
    );
  return (
    <section aria-labelledby="reactivate-title" className="flex flex-col gap-3 rounded-md border border-line bg-subtle p-3.5" data-testid="reactivate-confirm">
      <h3 id="reactivate-title" className="m-0 text-base font-semibold">
        Reactivate this detail
      </h3>
      <p className="m-0 text-sm text-muted">It opens again under the normal release rules. No sign-up comes back: anyone who still wants it signs up again.</p>
      <ReactivatePeople {...preview} />
      <form
        className="flex flex-col gap-3 border-t border-divider pt-3"
        onSubmit={(e) => {
          e.preventDefault();
          run(() => reactivateDetailAction({ jobId, reason }));
        }}
      >
        <FormField label="Reason" hint="Kept in the detail's history for coordinators and admins. Deputies and the vendor do not see it.">
          <Input value={reason} onChange={(e) => setReason(e.target.value)} required maxLength={500} />
        </FormField>
        <div className="flex flex-col gap-2 md:flex-row md:flex-wrap">
          <Button type="submit" busy={busy} className="w-full md:w-auto">
            Reactivate
          </Button>
          <Button type="button" variant="secondary" onClick={() => setOpen(false)} className="w-full md:w-auto">
            Keep it canceled
          </Button>
        </div>
      </form>
    </section>
  );
}

function notifyText(notify: Named[]): string {
  if (!notify.length) return "The vendor. Nobody was on it when it was canceled.";
  return `${names(notify)}, who ${notify.length === 1 ? "was" : "were"} on it when it was canceled, and the vendor.`;
}

/** The confirm step's lists: who is told, and whose late-cancel pay reactivating cancels. */
export function ReactivatePeople({ notify, unbilled }: Readonly<Preview>) {
  return (
    <>
      <div className="flex flex-col gap-1">
        <h4 className="m-0 text-sm font-semibold">Who is told</h4>
        <p className="m-0 text-sm" data-testid="reactivate-notify">
          {notifyText(notify)}
        </p>
      </div>
      {unbilled.length ? (
        <div className="flex flex-col gap-1">
          <h4 className="m-0 text-sm font-semibold">Late-cancel pay canceled</h4>
          <p className="m-0 text-sm" data-testid="reactivate-late-cancel">
            {names(unbilled)}. The vendor is going ahead, so no late cancel happened. They can sign up again like anyone else.
          </p>
        </div>
      ) : null}
    </>
  );
}

export function OpsPlanReview({ opsPlanId, versionId }: Readonly<{ opsPlanId: string; versionId: string }>) {
  const [comments, setComments] = useState("");
  const { run, busy } = useCoordAction();
  return (
    <div className="flex flex-col gap-2.5">
      <FormField label="Comments" hint="Required to deny.">
        <TextArea value={comments} onChange={(e) => setComments(e.target.value)} maxLength={4000} />
      </FormField>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" busy={busy} onClick={() => run(() => reviewOpsPlanAction({ opsPlanId, versionId, decision: "agreed", comments }))}>
          Agree
        </Button>
        <Button size="sm" variant="danger" busy={busy} onClick={() => run(() => reviewOpsPlanAction({ opsPlanId, versionId, decision: "denied", comments }))}>
          Deny
        </Button>
      </div>
    </div>
  );
}

/** Posts the contract to the attachments API (multipart), so a file up to the shared upload limit skips the server action body limit. */
async function attachContract(jobId: string, label: string, source: { file: File } | { url: string }): Promise<{ ok: true; message: string } | { ok: false; error: string }> {
  const body = new FormData();
  body.set("label", label);
  if ("file" in source) body.set("file", source.file);
  else body.set("url", source.url);
  const res = await fetch(`/api/v1/jobs/${jobId}/attachments`, { method: "POST", body });
  if (res.ok) return { ok: true, message: "Contract attached." };
  const err = await res.json().catch(() => null);
  return { ok: false, error: err?.error?.message ?? "The contract was not attached. Check the file or link and try again." };
}

/**
 * Attach a contract to this one detail: a file (up to the shared upload limit) or an https link, with a label.
 * Open when the detail has no contract; folded behind a button when one covers it, to attach a replacement.
 */
export function AttachContract({ jobId, missing, maxBytes }: Readonly<{ jobId: string; missing: boolean; maxBytes: number }>) {
  const [open, setOpen] = useState(missing);
  const [source, setSource] = useState<"file" | "link">("file");
  const [label, setLabel] = useState("");
  const [url, setUrl] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [tooBig, setTooBig] = useState(false);
  const { run, busy } = useCoordAction();
  const limitMb = Math.round(maxBytes / (1024 * 1024));
  if (!open && !missing)
    return (
      <Button size="sm" variant="secondary" onClick={() => setOpen(true)} className="w-fit">
        Attach a different contract
      </Button>
    );
  return (
    <form
      aria-label="Attach contract"
      className="flex flex-col gap-3 border-t border-divider pt-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (source === "file" && (!file || file.size > maxBytes)) return;
        run(
          () => attachContract(jobId, label, source === "file" ? { file: file! } : { url }),
          () => {
            setLabel("");
            setUrl("");
            setFile(null);
            setOpen(false);
          },
        );
      }}
    >
      <h3 className="m-0 text-body font-semibold">Attach contract</h3>
      <fieldset className="m-0 flex flex-col gap-1.5 border-0 p-0">
        <legend className="mb-1.5 p-0 text-sm font-medium text-muted">Contract is a</legend>
        <div className="flex w-full gap-1 rounded-md border border-line bg-surface p-1 sm:w-fit">
          {(["file", "link"] as const).map((k) => (
            <label
              key={k}
              className="inline-flex min-h-9 flex-1 cursor-pointer items-center justify-center rounded-sm px-3 text-body font-medium whitespace-nowrap text-muted hover:bg-subtle hover:text-ink has-checked:bg-accent-soft has-checked:font-semibold has-checked:text-link has-focus-visible:outline-2 has-focus-visible:outline-offset-2 has-focus-visible:outline-focus pointer-coarse:min-h-11 sm:flex-none"
            >
              <input type="radio" name="contract-source" value={k} checked={source === k} onChange={() => setSource(k)} className="sr-only" />
              {k === "file" ? "File" : "Link"}
            </label>
          ))}
        </div>
      </fieldset>
      <div className="grid gap-3 sm:grid-cols-2">
        <FormField label="Label" hint="What the contract is, as it shows on the detail.">
          <Input value={label} onChange={(e) => setLabel(e.target.value)} required maxLength={200} />
        </FormField>
        {source === "file" ? (
          <FormField label="Contract file" hint={`PDF, Word, JPG or PNG, up to ${limitMb} MB.`} error={tooBig ? `This file is larger than ${limitMb} MB. Use a smaller copy or attach a link.` : undefined}>
            <Input
              type="file"
              accept=".pdf,.docx,.jpg,.jpeg,.png"
              onChange={(e) => {
                const f = e.target.files?.[0] ?? null;
                setFile(f);
                setTooBig(!!f && f.size > maxBytes);
              }}
              required
              className="py-2"
            />
          </FormField>
        ) : (
          <FormField label="Link" hint="Must start with https://">
            <Input type="url" value={url} onChange={(e) => setUrl(e.target.value)} required />
          </FormField>
        )}
      </div>
      <div className="flex flex-wrap gap-2">
        <Button type="submit" size="sm" busy={busy} disabled={tooBig && source === "file"}>
          Attach contract
        </Button>
        {missing ? null : (
          <Button type="button" size="sm" variant="secondary" onClick={() => setOpen(false)}>
            Close
          </Button>
        )}
      </div>
    </form>
  );
}
