"use client";

import { useRef, useState } from "react";
import { Disclosure } from "@/ui/components/Disclosure";
import { CheckList, type CheckItem } from "@/ui/components/CheckList";
import { FormField, Select, TextArea } from "@/ui/components/FormField";
import { ActionLink, Button } from "@/ui/components/Button";
import { Chip } from "@/ui/components/Chip";
import { Notice } from "@/ui/components/Notice";
import { GIVE_AWAY_TERMS } from "@/domain/assignments/terms";
import { cancelSignupAction, claimSpotAction, joinBackupAction, offerSpotAction, signUpAction, withdrawOfferAction } from "../../_personnel/actions";
import { signUpState } from "./sign-up-state";
import { ActionStatus, useAction } from "../../_personnel/use-action";

export type TimeOption = { value: string; label: string };

export type PositionChoice = {
  id: string;
  name: string;
  open: number;
  /** Open spots whose deputies offer them to someone else: taking one replaces that deputy. */
  offered: number;
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
  /**
   * `claimPositionId`: a backup whose turn it is (or with a free spot no offer holds) can take it. `offered`: the
   * person offers their spot to someone else; `messageHref` opens New message about this detail.
   */
  mine: { assignmentId: string; label: string; status: string; started: boolean; claimPositionId: string | null; offered: boolean; confidential: boolean; messageHref: string } | null;
  /** The person's sign-up here ended (taken over, removed or canceled) and they hold no other: its status and why. */
  ended: { status: string; reason: string | null } | null;
};

function acceptLabel(backup: boolean, takeover: boolean): string {
  if (backup) return "Accept and join backup list";
  return takeover ? "Accept and take over" : "Accept and sign up";
}

/** "3 open", "full, backup list open" or "full". */
function openText(x: PositionChoice): string {
  if (x.open > 0) return `${x.open} open`;
  return x.canBackup ? "full, backup list open" : "full";
}

/** The positions to choose from, each with its open spots; a full position without a backup list is muted. */
function PositionPicker({ positions, chosenId, onChoose }: Readonly<{ positions: PositionChoice[]; chosenId: string; onChoose: (id: string) => void }>) {
  return (
    <fieldset className="m-0 flex flex-col gap-2 border-0 p-0">
      <legend className="mb-1.5 text-sm font-medium text-muted">Position</legend>
      {positions.map((x) => {
        const on = x.id === chosenId;
        const off = !x.canSignUp && !x.canBackup;
        return (
          <label key={x.id} className={`flex min-h-11 items-center gap-2.5 rounded-md px-3 py-2 ${on ? "border-2 border-accent" : "border border-line"} ${off ? "text-muted" : ""}`}>
            <input type="radio" name="position" value={x.id} checked={on} onChange={() => onChoose(x.id)} className="size-4.5 accent-accent" />
            <span>
              {x.name} ({openText(x)})
            </span>
          </label>
        );
      })}
    </fieldset>
  );
}

/** A flexible detail's start and end choices, the allowed range and whether the times work. */
function FlexTimes({ flex, start, end, onStart, onEnd, timesOk }: Readonly<{ flex: NonNullable<Props["flex"]>; start: string; end: string; onStart: (v: string) => void; onEnd: (v: string) => void; timesOk: boolean }>) {
  return (
    <div className="flex flex-col gap-2">
      <div className="grid grid-cols-2 gap-2.5">
        <FormField label="Start">
          <Select value={start} onChange={(e) => onStart(e.target.value)}>
            {flex.starts.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </Select>
        </FormField>
        <FormField label="End">
          <Select value={end} onChange={(e) => onEnd(e.target.value)}>
            {flex.ends.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </Select>
        </FormField>
      </div>
      <p className="m-0 text-xs text-muted">
        Move within {flex.rangeText} in 15-minute steps.{flex.shorterNote ? ` ${flex.shorterNote}` : ""}
      </p>
      {!timesOk ? <p className="m-0 text-xs font-medium text-danger-ink">The end must be after the start.</p> : null}
    </div>
  );
}

type ActionState = ReturnType<typeof useAction>;

type Mine = NonNullable<Props["mine"]>;

/** The person's one current state, in words, announced when it changes. */
function StateLine({ text, offered }: Readonly<{ text: string; offered: boolean }>) {
  return (
    <p className="m-0 flex flex-wrap items-center gap-2 font-medium" data-testid="sign-up-state">
      {offered ? <Chip tone="warning">Offered</Chip> : null}
      <span>{text}</span>
    </p>
  );
}

/** "Give away this spot": the terms first, then the reason. The deputy keeps the spot until someone takes it. */
function GiveAway({ mine, act }: Readonly<{ mine: Mine; act: ActionState }>) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  if (mine.confidential) return <p className="m-0 text-sm text-muted">A confidential detail is never offered to others. Ask a coordinator if you cannot work it.</p>;
  if (!open)
    return (
      <Button variant="secondary" className="w-fit" onClick={() => setOpen(true)}>
        Give away this spot
      </Button>
    );
  return (
    <form
      className="flex flex-col gap-2.5"
      aria-labelledby="give-away-title"
      onSubmit={(e) => {
        e.preventDefault();
        act.run(() => offerSpotAction({ assignmentId: mine.assignmentId, reason }));
      }}
    >
      <h3 id="give-away-title" className="m-0 text-base font-semibold">
        Give away this spot
      </h3>
      <Notice tone="warning" as="div">
        {GIVE_AWAY_TERMS}
      </Notice>
      <FormField label="Reason" hint="Coordinators see this reason.">
        <TextArea value={reason} onChange={(e) => setReason(e.target.value)} required maxLength={500} className="min-h-16" />
      </FormField>
      <div className="flex flex-wrap gap-2">
        <Button type="submit" busy={act.busy}>
          Give away this spot
        </Button>
        <Button type="button" variant="secondary" onClick={() => setOpen(false)}>
          Keep my spot
        </Button>
      </div>
    </form>
  );
}

/** While the offer is open: the terms, Withdraw offer and the prompt to let others know. */
function OfferOpen({ mine, act }: Readonly<{ mine: Mine; act: ActionState }>) {
  return (
    <div className="flex flex-col gap-3">
      <p className="m-0 max-w-[65ch] text-sm text-muted">{GIVE_AWAY_TERMS}</p>
      <div className="flex flex-col gap-1">
        <p className="m-0">Would you like to let others know this spot is available?</p>
        <ActionLink href={mine.messageHref} icon="mail" data-testid="offer-message-link">
          Send a message
        </ActionLink>
      </div>
      <Button variant="secondary" className="w-fit" busy={act.busy} onClick={() => act.run(() => withdrawOfferAction({ assignmentId: mine.assignmentId }))}>
        Withdraw offer
      </Button>
    </div>
  );
}

/** A backup or a pending shorter request can leave before the detail starts. */
function LeaveForm({ mine, act }: Readonly<{ mine: Mine; act: ActionState }>) {
  const [reason, setReason] = useState("");
  const backup = mine.status === "backup";
  return (
    <form
      className="flex flex-col gap-2.5"
      onSubmit={(e) => {
        e.preventDefault();
        act.run(() => cancelSignupAction({ assignmentId: mine.assignmentId, reason }));
      }}
    >
      <FormField label={backup ? "Reason for leaving the backup list" : "Reason for canceling the request"} hint="Coordinators see this reason.">
        <TextArea value={reason} onChange={(e) => setReason(e.target.value)} required maxLength={500} className="min-h-16" />
      </FormField>
      <Button type="submit" variant="secondary" busy={act.busy} className="w-fit">
        {backup ? "Leave the backup list" : "Cancel my request"}
      </Button>
    </form>
  );
}

/** What the person can do from their state before the detail starts. */
function MyActions({ mine, act }: Readonly<{ mine: Mine; act: ActionState }>) {
  if (mine.started) return <p className="m-0 text-sm text-muted">This detail has started. Ask a coordinator if you need to be removed.</p>;
  if (mine.offered) return <OfferOpen mine={mine} act={act} />;
  if (mine.status === "signed_up") return <GiveAway mine={mine} act={act} />;
  return <LeaveForm mine={mine} act={act} />;
}

/**
 * The person is on this detail: their one current state, taking an open spot when it is their turn, and giving the
 * spot away (or leaving a backup place) before it starts. Each action's result shows once, in one status line.
 */
function MySignUp({ mine, jobId, warningVersion, act }: Readonly<{ mine: Mine; jobId: string; warningVersion: number; act: ActionState }>) {
  const state = signUpState(mine, null);
  return (
    <div className="flex flex-col gap-3">
      <StateLine text={state.text} offered={mine.offered} />
      {mine.claimPositionId ? (
        <div className="flex flex-col gap-2.5">
          <p className="m-0">A spot is open for you. Take it before your turn ends.</p>
          <Button size="lg" full busy={act.busy} onClick={() => act.run(() => claimSpotAction({ jobId, jobPositionId: mine.claimPositionId!, warningVersion }))}>
            Take the open spot
          </Button>
        </div>
      ) : null}
      <MyActions mine={mine} act={act} />
      <ActionStatus result={act.result} />
    </div>
  );
}

/**
 * The sign-up card: each rule with its exact message, the flexible time picker, and the agency warning in a
 * dialog that must be accepted (its version goes with the request). The button is disabled when no rule allows
 * signing up; "Join backup list" replaces it when the detail is full.
 */
export function SignUpPanel(p: Readonly<Props>) {
  // One action at a time and one result line: the state comes from the server after each action (the page refreshes),
  // and only the latest action's result shows, so two states never appear together.
  const act = useAction();
  const state = signUpState(p.mine, p.ended);
  if (p.mine) return <MySignUp mine={p.mine} jobId={p.jobId} warningVersion={p.warningVersion} act={act} />;
  return <SignUpForm {...p} stateText={state.text} act={act} />;
}

/** Sign-up for someone not on the detail, under the state their last sign-up here ended in, if any. */
function SignUpForm(p: Readonly<Props & { stateText: string; act: ActionState }>) {
  const usable = p.positions.filter((x) => x.canSignUp || x.canBackup);
  const [chosenId, setChosenId] = useState((p.positions.find((x) => x.canSignUp) ?? usable[0] ?? p.positions[0]).id);
  const chosen = p.positions.find((x) => x.id === chosenId) ?? p.positions[0];
  const dialog = useRef<HTMLDialogElement>(null);
  const { run, busy, result } = p.act;
  const [start, setStart] = useState(p.flex?.start ?? "");
  const [end, setEnd] = useState(p.flex?.end ?? "");
  const backup = !chosen.canSignUp && chosen.canBackup;
  // Every open spot is one its deputy offers: signing up takes it over.
  const takeover = !backup && chosen.offered > 0 && chosen.open <= chosen.offered;
  let label = `Sign up for ${chosen.name}`;
  if (backup) label = "Join backup list";
  else if (takeover) label = "Take over this spot";
  const shown = chosen.checks.filter((c) => !c.ok || c.cap);
  const folded = chosen.checks.filter((c) => c.ok && !c.cap);
  const allMet = chosen.checks.every((c) => c.ok);
  const timesOk = !p.flex || new Date(end).getTime() > new Date(start).getTime();

  return (
    <div className="flex flex-col gap-3.5">
      {p.stateText ? <StateLine text={p.stateText} offered={false} /> : null}
      {takeover ? <p className="m-0 text-sm">A deputy offers this spot. Taking it over replaces them on the detail.</p> : null}
      {usable.length > 1 ? <PositionPicker positions={p.positions} chosenId={chosenId} onChoose={setChosenId} /> : null}
      {p.flex ? <FlexTimes flex={p.flex} start={start} end={end} onStart={setStart} onEnd={setEnd} timesOk={timesOk} /> : null}
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
            const signUp = p.flex ? { ...base, plannedStartAt: start, plannedEndAt: end } : base;
            run(() => (backup ? joinBackupAction(base) : signUpAction(signUp)));
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
              {acceptLabel(backup, takeover)}
            </Button>
          </div>
        </form>
      </dialog>
    </div>
  );
}
