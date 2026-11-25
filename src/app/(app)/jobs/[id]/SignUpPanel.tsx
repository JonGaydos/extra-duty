"use client";

import { useRef, useState } from "react";
import { Button } from "@/ui/components/Button";
import { Disclosure } from "@/ui/components/Disclosure";
import { CheckList, type CheckItem } from "@/ui/components/CheckList";
import { FormField, Select, TextArea } from "@/ui/components/FormField";
import { cancelSignupAction, claimSpotAction, joinBackupAction, signUpAction } from "../../_personnel/actions";
import { ActionStatus, useAction } from "../../_personnel/use-action";

export type TimeOption = { value: string; label: string };

export type PositionChoice = {
  id: string;
  name: string;
  open: number;
  canSignUp: boolean;
  canBackup: boolean;
  /** `cap` rules stay in view with the person's hours; other met rules fold away. */
  checks: Array<CheckItem & { cap: boolean }>;
};

type Props = {
  jobId: string;
  positions: PositionChoice[];
  warningText: string;
  warningVersion: number;
  /** Flexible jobs: start and end choices in 15-minute steps within the allowed range. */
  flex: { starts: TimeOption[]; ends: TimeOption[]; start: string; end: string; rangeText: string; shorterNote: string | null } | null;
  /** `claimPositionId`: a backup whose turn it is (or with a free spot no offer holds) can take it. */
  mine: { assignmentId: string; label: string; started: boolean; claimPositionId: string | null } | null;
};

/**
 * The sign-up card: each rule with its exact message, the flexible time picker, and the agency warning in a
 * dialog that must be accepted (its version goes with the request). The button is disabled when no rule allows
 * signing up; "Join backup list" replaces it when the detail is full.
 */
export function SignUpPanel(p: Props) {
  const usable = p.positions.filter((x) => x.canSignUp || x.canBackup);
  const [chosenId, setChosenId] = useState((p.positions.find((x) => x.canSignUp) ?? usable[0] ?? p.positions[0]).id);
  const chosen = p.positions.find((x) => x.id === chosenId) ?? p.positions[0];
  const dialog = useRef<HTMLDialogElement>(null);
  const { run, busy, result } = useAction();
  const cancel = useAction();
  const claim = useAction();
  const [start, setStart] = useState(p.flex?.start ?? "");
  const [end, setEnd] = useState(p.flex?.end ?? "");
  const [reason, setReason] = useState("");
  const backup = !chosen.canSignUp && chosen.canBackup;
  const label = backup ? "Join backup list" : `Sign up for ${chosen.name}`;
  const shown = chosen.checks.filter((c) => !c.ok || c.cap);
  const folded = chosen.checks.filter((c) => c.ok && !c.cap);
  const allMet = chosen.checks.every((c) => c.ok);
  const timesOk = !p.flex || new Date(end).getTime() > new Date(start).getTime();

  if (p.mine) {
    return (
      <div className="flex flex-col gap-3">
        <p className="m-0 font-medium">
          {p.mine.label === "Signed up" ? "You are signed up for this detail." : `You are on this detail: ${p.mine.label}.`}
        </p>
        <ActionStatus result={result} />
        {p.mine.claimPositionId ? (
          <div className="flex flex-col gap-2.5">
            <p className="m-0">A spot is open for you. Take it before your turn ends.</p>
            <Button
              size="lg"
              full
              busy={claim.busy}
              onClick={() => claim.run(() => claimSpotAction({ jobId: p.jobId, jobPositionId: p.mine!.claimPositionId!, warningVersion: p.warningVersion }))}
            >
              Take the open spot
            </Button>
          </div>
        ) : null}
        <ActionStatus result={claim.result} />
        {!p.mine.started ? (
          <form
            className="flex flex-col gap-2.5"
            onSubmit={(e) => {
              e.preventDefault();
              cancel.run(() => cancelSignupAction({ assignmentId: p.mine!.assignmentId, reason }));
            }}
          >
            <FormField label="Reason for canceling" hint="Coordinators see this reason.">
              <TextArea value={reason} onChange={(e) => setReason(e.target.value)} required maxLength={500} className="min-h-16" />
            </FormField>
            <Button type="submit" variant="secondary" busy={cancel.busy} className="w-fit">
              Cancel my sign-up
            </Button>
            <ActionStatus result={cancel.result} />
          </form>
        ) : (
          <p className="m-0 text-sm text-muted">This detail has started. Ask a coordinator if you need to be removed.</p>
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3.5">
      {usable.length > 1 ? (
        <fieldset className="m-0 flex flex-col gap-2 border-0 p-0">
          <legend className="mb-1.5 text-sm font-medium text-muted">Position</legend>
          {p.positions.map((x) => {
            const on = x.id === chosenId;
            const off = !x.canSignUp && !x.canBackup;
            return (
              <label key={x.id} className={`flex min-h-11 items-center gap-2.5 rounded-md px-3 py-2 ${on ? "border-2 border-accent" : "border border-line"} ${off ? "text-muted" : ""}`}>
                <input type="radio" name="position" value={x.id} checked={on} onChange={() => setChosenId(x.id)} className="size-4.5 accent-accent" />
                <span>
                  {x.name} ({x.open > 0 ? `${x.open} open` : x.canBackup ? "full, backup list open" : "full"})
                </span>
              </label>
            );
          })}
        </fieldset>
      ) : null}
      {p.flex ? (
        <div className="flex flex-col gap-2">
          <div className="grid grid-cols-2 gap-2.5">
            <FormField label="Start">
              <Select value={start} onChange={(e) => setStart(e.target.value)}>
                {p.flex.starts.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </Select>
            </FormField>
            <FormField label="End">
              <Select value={end} onChange={(e) => setEnd(e.target.value)}>
                {p.flex.ends.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </Select>
            </FormField>
          </div>
          <p className="m-0 text-xs text-muted">
            Move within {p.flex.rangeText} in 15-minute steps.{p.flex.shorterNote ? ` ${p.flex.shorterNote}` : ""}
          </p>
          {!timesOk ? <p className="m-0 text-xs font-medium text-danger-ink">The end must be after the start.</p> : null}
        </div>
      ) : null}
      <CheckList items={shown} />
      {folded.length > 0 ? (
        <Disclosure label={allMet ? `All checks passed (${chosen.checks.length})` : `${folded.length} other checks passed`}>
          <div className="pt-1">
            <CheckList items={folded} />
          </div>
        </Disclosure>
      ) : null}
      <Button
        size="lg"
        full
        disabled={(!chosen.canSignUp && !chosen.canBackup) || !timesOk}
        busy={busy}
        onClick={() => dialog.current?.showModal()}
      >
        {label}
      </Button>
      <ActionStatus result={result} />
      {/* After canceling, the panel turns back into sign-up: the confirmation stays in view. */}
      <ActionStatus result={cancel.result} />
      <dialog
        ref={dialog}
        aria-labelledby="warning-title"
        className="m-auto w-[min(92vw,30rem)] rounded-2xl border border-line bg-surface p-0 text-ink backdrop:bg-ink/40"
      >
        <form
          method="dialog"
          className="flex flex-col gap-4 p-5"
          onSubmit={(e) => {
            e.preventDefault();
            dialog.current?.close();
            const base = { jobId: p.jobId, jobPositionId: chosen.id, warningVersion: p.warningVersion };
            run(() =>
              backup
                ? joinBackupAction(base)
                : signUpAction(p.flex ? { ...base, plannedStartAt: start, plannedEndAt: end } : base),
            );
          }}
        >
          <h2 id="warning-title" className="m-0 text-lg font-bold">
            Before you sign up
          </h2>
          <p className="m-0 max-w-[65ch] whitespace-pre-line">{p.warningText}</p>
          <div className="flex flex-wrap justify-end gap-2">
            <Button type="button" variant="secondary" onClick={() => dialog.current?.close()}>
              Not now
            </Button>
            <Button type="submit" autoFocus>
              {backup ? "Accept and join backup list" : "Accept and sign up"}
            </Button>
          </div>
        </form>
      </dialog>
    </div>
  );
}
