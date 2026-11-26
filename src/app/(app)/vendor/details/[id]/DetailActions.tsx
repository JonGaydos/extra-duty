"use client";

import { useId, useState } from "react";
import { Button } from "@/ui/components/Button";
import { Card, CardTitle } from "@/ui/components/Card";
import { FormField, Input, TextArea } from "@/ui/components/FormField";
import { Notice } from "@/ui/components/Notice";
import { ActionStatus, useAction } from "../../../_personnel/use-action";
import { cancelDetailAction, editDetailAction } from "../../_vendor/actions";

type Allowed = { allowed: boolean; reason: string | null };
type Position = { positionTypeId: string; name: string; count: number };

/** Why a control is off, in words beside it; the button stays on screen, disabled. */
function Reason({ id, children }: Readonly<{ id: string; children: string }>) {
  return (
    <p id={id} className="m-0 text-sm text-muted">
      {children}
    </p>
  );
}

type Form = { date: string; start: string; end: string; description: string; notes: string };
type Schedule = Allowed & { needsApproval: boolean; positionsOnly: boolean };

/** What a change does: a request changes until decided; on an approved detail, schedule changes need approval. */
function changesNote(requested: boolean, schedule: Schedule): string {
  if (requested) return "You can change this request until a coordinator decides.";
  if (schedule.allowed && schedule.needsApproval)
    return "Changes to the date, time or headcount go to a coordinator for approval, with anything saved alongside them. Description and notes saved on their own change right away.";
  return "Description and notes change right away.";
}

/** The change form: date and times when allowed (or why not), headcounts, description and notes. */
function EditForm({
  times,
  schedule,
  positions,
  counts,
  setCounts,
  editAllowed,
  form,
  setForm,
  busy,
  onSave,
  onClose,
}: Readonly<{
  times: boolean;
  schedule: Schedule;
  positions: Position[];
  counts: string[];
  setCounts: (c: string[]) => void;
  editAllowed: boolean;
  form: Form;
  setForm: (f: Form) => void;
  busy: boolean;
  onSave: () => void;
  onClose: () => void;
}>) {
  // The date and times when they may change, or why they may not (a render function, so it keeps its place).
  const whenFields = () => {
    if (times)
      return (
        <div className="grid gap-3 sm:grid-cols-3 md:grid-cols-1 lg:grid-cols-3">
          <FormField label="Date">
            <Input type="date" value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} required />
          </FormField>
          <FormField label="Start">
            <Input type="time" value={form.start} onChange={(e) => setForm({ ...form, start: e.target.value })} required />
          </FormField>
          <FormField label="End">
            <Input type="time" value={form.end} onChange={(e) => setForm({ ...form, end: e.target.value })} required />
          </FormField>
        </div>
      );
    return schedule.reason ? <Notice tone="info">{schedule.reason}</Notice> : null;
  };
  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        onSave();
      }}
    >
      {whenFields()}
      {schedule.allowed
        ? positions.map((p, i) => (
            <FormField key={p.positionTypeId} label={`${p.name}, how many`} hint={schedule.positionsOnly ? "You can add positions, not remove them." : undefined}>
              <Input
                type="number"
                inputMode="numeric"
                min={schedule.positionsOnly ? p.count : 1}
                max={99}
                value={counts[i]}
                onChange={(e) => setCounts(counts.map((c, j) => (j === i ? e.target.value : c)))}
                required
                data-numeric
              />
            </FormField>
          ))
        : null}
      {editAllowed ? (
        <>
          <FormField label="What the deputies will do">
            <TextArea value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} maxLength={5000} />
          </FormField>
          <FormField label="Notes">
            <TextArea value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} maxLength={2000} />
          </FormField>
        </>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" busy={busy}>
          Save changes
        </Button>
        <Button type="button" variant="secondary" onClick={onClose}>
          Close
        </Button>
      </div>
    </form>
  );
}

/** Cancel or withdraw: late cancellation pay when inside the window, and the reason. */
function CancelForm({
  requested,
  cancel,
  signedUp,
  reason,
  setReason,
  busy,
  onCancel,
  onClose,
}: Readonly<{ requested: boolean; cancel: Allowed & { latePay: boolean; lateHours: number }; signedUp: number; reason: string; setReason: (v: string) => void; busy: boolean; onCancel: () => void; onClose: () => void }>) {
  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        onCancel();
      }}
    >
      {cancel.latePay ? (
        <Notice tone="warning">
          This is within {cancel.lateHours} hours of the start, so each of the {signedUp} {signedUp === 1 ? "person" : "people"} signed up is paid late cancellation pay.
        </Notice>
      ) : null}
      <FormField label="Reason for cancelling" hint="The coordinators and the people signed up see this.">
        <TextArea value={reason} onChange={(e) => setReason(e.target.value)} required maxLength={1000} />
      </FormField>
      <div className="flex flex-wrap gap-2">
        <Button type="submit" variant="danger" busy={busy}>
          {requested ? "Withdraw request" : "Confirm cancellation"}
        </Button>
        <Button type="button" variant="secondary" onClick={onClose}>
          Keep it
        </Button>
      </div>
    </form>
  );
}

/**
 * "Change detail" and "Cancel detail" as the vendor settings allow. A locked action stays visible but disabled,
 * with the rule in words. Date, time and headcount changes on an approved detail go to a coordinator.
 */
export function DetailActions({
  jobId,
  requested,
  current,
  positions,
  edit,
  schedule,
  cancel,
  signedUp,
}: Readonly<{
  jobId: string;
  requested: boolean;
  current: { date: string; start: string; end: string; description: string; notes: string };
  positions: Position[];
  edit: Allowed;
  schedule: Schedule;
  cancel: Allowed & { latePay: boolean; lateHours: number };
  signedUp: number;
}>) {
  const [open, setOpen] = useState<"edit" | "cancel" | null>(null);
  const [form, setForm] = useState(current);
  const [counts, setCounts] = useState(positions.map((p) => String(p.count)));
  const [reason, setReason] = useState("");
  const { run, busy, result, clear } = useAction();
  const editReasonId = useId();
  const cancelReasonId = useId();
  const canChange = edit.allowed || schedule.allowed;
  const changeReason = edit.reason ?? schedule.reason ?? "This detail cannot be changed.";
  const times = schedule.allowed && !schedule.positionsOnly;

  const save = () => {
    const when = times && (form.date !== current.date || form.start !== current.start || form.end !== current.end) ? { date: form.date, start: form.start, end: form.end } : null;
    const changedCounts = schedule.allowed && counts.some((c, i) => Number(c) !== positions[i].count);
    const text = edit.allowed && (form.description !== current.description || form.notes !== current.notes) ? { description: form.description, notes: form.notes } : null;
    run(
      () =>
        editDetailAction({
          jobId,
          when,
          positions: changedCounts ? positions.map((p, i) => ({ positionTypeId: p.positionTypeId, count: Number(counts[i]) })) : null,
          text,
        }),
      () => setOpen(null),
    );
  };

  // The open form, or the two buttons (a render function, so the panel keeps its place in the card).
  const panel = () => {
    if (open === "edit")
      return (
        <EditForm
          times={times}
          schedule={schedule}
          positions={positions}
          counts={counts}
          setCounts={setCounts}
          editAllowed={edit.allowed}
          form={form}
          setForm={setForm}
          busy={busy}
          onSave={save}
          onClose={() => setOpen(null)}
        />
      );
    if (open === "cancel")
      return (
        <CancelForm
          requested={requested}
          cancel={cancel}
          signedUp={signedUp}
          reason={reason}
          setReason={setReason}
          busy={busy}
          onCancel={() => run(() => cancelDetailAction({ jobId, reason }), () => setOpen(null))}
          onClose={() => setOpen(null)}
        />
      );
    return (
      <div className="flex flex-col gap-3">
        <div className="flex flex-col gap-1.5">
          <Button
            variant="secondary"
            disabled={!canChange}
            aria-describedby={canChange ? undefined : editReasonId}
            onClick={() => {
              clear();
              setForm(current);
              setCounts(positions.map((p) => String(p.count)));
              setOpen("edit");
            }}
          >
            Change detail
          </Button>
          {canChange ? null : <Reason id={editReasonId}>{changeReason}</Reason>}
        </div>
        <div className="flex flex-col gap-1.5">
          <Button
            variant="secondary"
            disabled={!cancel.allowed}
            aria-describedby={cancel.allowed ? undefined : cancelReasonId}
            onClick={() => {
              clear();
              setOpen("cancel");
            }}
          >
            {requested ? "Withdraw request" : "Cancel detail"}
          </Button>
          {cancel.allowed ? null : <Reason id={cancelReasonId}>{cancel.reason ?? "This detail cannot be canceled."}</Reason>}
        </div>
      </div>
    );
  };

  return (
    <Card>
      <CardTitle>Changes</CardTitle>
      {canChange ? (
        <p className="m-0 text-sm text-muted">
          {changesNote(requested, schedule)}
        </p>
      ) : null}

      {panel()}
      <ActionStatus result={result} />
    </Card>
  );
}
