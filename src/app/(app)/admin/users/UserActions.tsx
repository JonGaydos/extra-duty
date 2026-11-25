"use client";

import { useState } from "react";
import type { Role } from "@/domain/actor";
import { Button } from "@/ui/components/Button";
import { Card, CardTitle } from "@/ui/components/Card";
import { FormField, Input, Select, TextArea } from "@/ui/components/FormField";
import { PhoneField } from "@/ui/components/PhoneField";
import { useCoordAction } from "../../coordinate/_coordinator/status";
import { Chip } from "@/ui/components/Chip";
import { dollars } from "@/ui/components/PayLabel";
import { dateLabel, dayLabel } from "../../_personnel/format";
import {
  deactivateUserAction,
  departureChecklistAction,
  grantFlagAction,
  inviteUserAction,
  liftSuspensionAction,
  reactivateUserAction,
  resendInviteAction,
  revokeFlagAction,
  suspendUserAction,
  updateUserAction,
  writeOffDetailAction,
} from "../_admin/actions";
import { SIGNUP_STATUS_LABEL, UNPAID_STATUS_LABEL } from "./departure-labels";
import { Check, CheckGroup } from "../_admin/forms";

type Option = { id: string; name: string };
type Account = { name: string; phone: string; role: Role; rankId: string; badgeNumber: string };

function AccountFields({ value, onChange, ranks, canPickAdmin, email }: { value: Account; onChange: (v: Account) => void; ranks: Option[]; canPickAdmin: boolean; email?: { value: string; set: (v: string) => void } }) {
  const set = (k: keyof Account) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => onChange({ ...value, [k]: e.target.value });
  return (
    <div className="grid gap-3 md:grid-cols-2">
      <FormField label="Name">
        <Input value={value.name} onChange={set("name")} required maxLength={200} autoComplete="off" />
      </FormField>
      {email ? (
        <FormField label="Email" hint="The invite goes here. It is also how they sign in.">
          <Input type="email" value={email.value} onChange={(e) => email.set(e.target.value)} required maxLength={320} autoComplete="off" />
        </FormField>
      ) : null}
      <FormField label="Role">
        <Select value={value.role} onChange={set("role")}>
          <option value="personnel">Personnel</option>
          <option value="coordinator">Coordinator</option>
          {canPickAdmin ? <option value="admin">Admin</option> : null}
        </Select>
      </FormField>
      <FormField label="Rank">
        <Select value={value.rankId} onChange={set("rankId")}>
          <option value="">No rank</option>
          {ranks.map((r) => (
            <option key={r.id} value={r.id}>
              {r.name}
            </option>
          ))}
        </Select>
      </FormField>
      <FormField label="Phone">
        <PhoneField value={value.phone} onValue={(phone) => onChange({ ...value, phone })} />
      </FormField>
      <FormField label="Badge number">
        <Input value={value.badgeNumber} onChange={set("badgeNumber")} maxLength={40} />
      </FormField>
    </div>
  );
}

export function InviteUser({ canInviteAdmins, ranks, flags }: { canInviteAdmins: boolean; ranks: Option[]; flags: Option[] }) {
  const empty: Account = { name: "", phone: "", role: "personnel", rankId: "", badgeNumber: "" };
  const [open, setOpen] = useState(false);
  const [v, setV] = useState<Account>(empty);
  const [email, setEmail] = useState("");
  const [flagIds, setFlagIds] = useState<string[]>([]);
  const { run, busy } = useCoordAction();
  if (!open)
    return (
      <Button onClick={() => setOpen(true)} className="w-fit">
        Invite user
      </Button>
    );
  return (
    <Card tone="accent" as="div">
      <CardTitle>Invite user</CardTitle>
      <p className="m-0 text-sm text-muted">They get an email with a link to set a password. The link works for 7 days.</p>
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          run(
            () => inviteUserAction({ ...v, email, qualificationIds: flagIds }),
            () => {
              setV(empty);
              setEmail("");
              setFlagIds([]);
              setOpen(false);
            },
          );
        }}
      >
        <AccountFields value={v} onChange={setV} ranks={ranks} canPickAdmin={canInviteAdmins} email={{ value: email, set: setEmail }} />
        {flags.length ? <CheckGroup legend="Special flags" options={flags} value={flagIds} onChange={setFlagIds} /> : null}
        <div className="flex flex-wrap gap-2">
          <Button type="submit" busy={busy}>
            Send invite
          </Button>
          <Button type="button" variant="secondary" onClick={() => setOpen(false)}>
            Close
          </Button>
        </div>
      </form>
    </Card>
  );
}

export function EditAccount({ userId, initial, ranks, canPickAdmin }: { userId: string; initial: Account; ranks: Option[]; canPickAdmin: boolean }) {
  const [open, setOpen] = useState(false);
  const [v, setV] = useState(initial);
  const { run, busy } = useCoordAction();
  if (!open)
    return (
      <Button variant="secondary" onClick={() => setOpen(true)} className="w-fit">
        Edit account
      </Button>
    );
  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        run(() => updateUserAction({ ...v, id: userId }), () => setOpen(false));
      }}
    >
      <AccountFields value={v} onChange={setV} ranks={ranks} canPickAdmin={canPickAdmin} />
      <div className="flex flex-wrap gap-2">
        <Button type="submit" busy={busy}>
          Save account
        </Button>
        <Button type="button" variant="secondary" onClick={() => setOpen(false)}>
          Close
        </Button>
      </div>
    </form>
  );
}

export function SuspendForm({ userId, today }: { userId: string; today: string }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [until, setUntil] = useState("");
  const [remove, setRemove] = useState(false);
  const { run, busy } = useCoordAction();
  if (!open)
    return (
      <>
        <p className="m-0 text-sm text-muted">Not suspended. A suspended person cannot sign up for details.</p>
        <Button variant="secondary" onClick={() => setOpen(true)} className="w-fit">
          Suspend user
        </Button>
      </>
    );
  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        run(() => suspendUserAction({ id: userId, reason, until, removeFutureAssignments: remove }));
      }}
    >
      <FormField label="Reason" hint="They see this in the alert about the suspension.">
        <TextArea value={reason} onChange={(e) => setReason(e.target.value)} required maxLength={1000} />
      </FormField>
      <FormField label="Suspended until" hint="It ends at the start of this day. Leave blank to keep it until you lift it.">
        <Input type="date" value={until} min={today} onChange={(e) => setUntil(e.target.value)} className="md:max-w-56" />
      </FormField>
      <Check label="Remove them from details they signed up for" hint="Their spots open for others." checked={remove} onChange={setRemove} />
      <div className="flex flex-wrap gap-2">
        <Button type="submit" variant="danger" busy={busy}>
          Confirm suspension
        </Button>
        <Button type="button" variant="secondary" onClick={() => setOpen(false)}>
          Close
        </Button>
      </div>
    </form>
  );
}

export function LiftSuspension({ userId }: { userId: string }) {
  const { run, busy } = useCoordAction();
  return (
    <Button variant="secondary" busy={busy} onClick={() => run(() => liftSuspensionAction(userId))} className="w-fit">
      Lift suspension
    </Button>
  );
}

export function RevokeFlag({ userId, qualificationId, label }: { userId: string; qualificationId: string; label: string }) {
  const { run, busy } = useCoordAction();
  return (
    <Button size="sm" variant="secondary" busy={busy} aria-label={`Revoke ${label}`} onClick={() => run(() => revokeFlagAction({ userId, qualificationId }))}>
      Revoke
    </Button>
  );
}

/** Grant one flag to one person: pick a flag (on a user page) or a person (on a flag page). */
export function GrantFlag({ userId, qualificationId, choices, chooseLabel }: { userId?: string; qualificationId?: string; choices: Option[]; chooseLabel: "Flag" | "Person" }) {
  const [pick, setPick] = useState("");
  const { run, busy } = useCoordAction();
  if (choices.length === 0) return null;
  return (
    <form
      className="flex flex-col gap-2 md:flex-row md:items-end"
      onSubmit={(e) => {
        e.preventDefault();
        run(() => grantFlagAction({ userId: userId ?? pick, qualificationId: qualificationId ?? pick }), () => setPick(""));
      }}
    >
      <div className="md:w-72">
        <FormField label={chooseLabel}>
          <Select value={pick} onChange={(e) => setPick(e.target.value)} required>
            <option value="">Choose</option>
            {choices.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>
        </FormField>
      </div>
      <Button type="submit" variant="secondary" busy={busy} className="w-full md:w-fit">
        Grant flag
      </Button>
    </form>
  );
}

type ChecklistRow = { assignmentId: string; jobNumber: number; title: string; vendorName: string; startAt: string; endAt: string };
type Checklist = {
  upcoming: Array<ChecklistRow & { status: string; position: string }>;
  unbilled: Array<ChecklistRow & { lateCancel: boolean }>;
  unpaid: Array<{ invoiceId: string; number: string; vendorName: string; jobNumber: number; status: string; totalCents: number }>;
};

/** One list in the departure checklist: a heading with its count, what happens to it, and the rows. */
function ChecklistSection({ title, what, count, children }: { title: string; what: string; count: number; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-1.5" aria-label={title}>
      <h3 className="m-0 flex items-baseline gap-2 text-sm font-semibold text-ink">
        {title}
        <span data-numeric className="text-muted">
          {count}
        </span>
      </h3>
      <p className="m-0 text-xs text-muted">{what}</p>
      {count ? <ul className="m-0 flex list-none flex-col divide-y divide-divider rounded-md border border-line bg-surface p-0">{children}</ul> : <p className="m-0 text-sm text-muted">None.</p>}
    </section>
  );
}

const CheckRow = ({ main, meta, chip }: { main: string; meta: string; chip?: string }) => (
  <li className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 px-3 py-2 text-sm">
    <span className="flex min-w-0 flex-col">
      <span className="font-medium text-ink">{main}</span>
      <span className="text-xs text-muted">{meta}</span>
    </span>
    {chip ? <Chip tone="neutral">{chip}</Chip> : null}
  </li>
);

/**
 * Turning someone off when they leave: the last day and a reason first, then the checklist (nothing changes yet),
 * then the confirmation. An admin's API keys that will stop working are listed and must be acknowledged.
 */
function DepartureFlow({ userId, name, today, apiKeys }: { userId: string; name: string; today: string; apiKeys: Array<{ name: string; prefix: string }> }) {
  const [step, setStep] = useState<"idle" | "form" | "review">("idle");
  const [lastDay, setLastDay] = useState(today);
  const [reason, setReason] = useState("");
  const [list, setList] = useState<Checklist | null>(null);
  const [keysOk, setKeysOk] = useState(false);
  const { run, busy } = useCoordAction();
  const hasKeys = apiKeys.length > 0;
  const close = () => {
    setStep("idle");
    setList(null);
    setKeysOk(false);
  };
  if (step === "idle")
    return (
      <Button variant="secondary" onClick={() => setStep("form")} className="w-fit">
        Deactivate user
      </Button>
    );
  if (step === "form" || !list)
    return (
      <form
        aria-label={`Turn off ${name}'s account`}
        className="flex flex-col gap-3 rounded-md border border-danger-line bg-danger-soft p-3"
        onSubmit={(e) => {
          e.preventDefault();
          run(
            () => departureChecklistAction({ id: userId, lastDay }),
            (r) => {
              setList(JSON.parse(r.value ?? "null") as Checklist);
              setStep("review");
            },
            { refresh: false, quiet: true },
          );
        }}
      >
        <p className="m-0 text-sm text-danger-ink">
          {name} is leaving. Their sign-ups after the last day are removed and the account is turned off. You see what is affected before anything changes.
        </p>
        <div className="grid gap-3 md:grid-cols-[minmax(0,12rem)_minmax(0,1fr)]">
          <FormField label="Last day" hint="Today or earlier.">
            <Input type="date" value={lastDay} max={today} onChange={(e) => setLastDay(e.target.value)} required />
          </FormField>
          <FormField label="Reason" hint="Staff only. Kept in the audit log.">
            <Input value={reason} onChange={(e) => setReason(e.target.value)} required maxLength={500} />
          </FormField>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button type="submit" busy={busy}>
            Review checklist
          </Button>
          <Button type="button" variant="secondary" onClick={close}>
            Keep account
          </Button>
        </div>
      </form>
    );
  const day = (iso: string) => dayLabel(new Date(iso));
  return (
    <div role="group" aria-label={`Checklist for ${name}`} className="flex flex-col gap-4 rounded-md border border-danger-line bg-danger-soft p-3">
      <p className="m-0 text-sm text-danger-ink">
        Turn off {name}&apos;s account, last day {dateLabel(new Date(`${lastDay}T12:00:00Z`))}? They are signed out and cannot sign in. Their history stays.
      </p>
      <ChecklistSection title="Upcoming sign-ups" what="Removed. Backups are offered the spots in turn, or the spots reopen. Nobody is told why." count={list.upcoming.length}>
        {list.upcoming.map((u) => (
          <CheckRow key={u.assignmentId} main={`#${u.jobNumber} ${u.vendorName}`} meta={`${day(u.startAt)}, ${u.position}`} chip={SIGNUP_STATUS_LABEL[u.status] ?? u.status} />
        ))}
      </ChecklistSection>
      <ChecklistSection title="Past details not billed" what="Stay listed for staff to bill for them or write off." count={list.unbilled.length}>
        {list.unbilled.map((u) => (
          <CheckRow key={u.assignmentId} main={`#${u.jobNumber} ${u.vendorName}`} meta={day(u.startAt)} chip={u.lateCancel ? "Late cancel" : undefined} />
        ))}
      </ChecklistSection>
      <ChecklistSection title="Unpaid invoices" what="Stay open. Vendors still owe them." count={list.unpaid.length}>
        {list.unpaid.map((i) => (
          <CheckRow key={i.invoiceId} main={`${i.number} ${i.vendorName}`} meta={`${dollars(i.totalCents)}, detail #${i.jobNumber}`} chip={UNPAID_STATUS_LABEL[i.status] ?? i.status} />
        ))}
      </ChecklistSection>
      {hasKeys ? (
        <div className="flex flex-col gap-1.5">
          <p className="m-0 text-sm font-semibold text-danger-ink">
            {apiKeys.length === 1 ? "1 active API key will stop working" : `${apiKeys.length} active API keys will stop working`}, and any system using {apiKeys.length === 1 ? "it" : "them"} will be refused:
          </p>
          <ul className="m-0 flex list-none flex-col gap-1 p-0">
            {apiKeys.map((k) => (
              <li key={k.prefix} className="flex flex-wrap items-baseline gap-x-2 text-sm text-ink">
                <span className="font-medium">{k.name}</span> <code className="text-xs text-muted">{k.prefix}</code>
              </li>
            ))}
          </ul>
          <label className="flex min-h-11 cursor-pointer items-center gap-2.5 text-sm text-ink">
            <input type="checkbox" checked={keysOk} onChange={(e) => setKeysOk(e.target.checked)} className="size-4.5 accent-accent" />
            I understand these keys will stop working
          </label>
        </div>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button variant="danger" busy={busy} disabled={hasKeys && !keysOk} onClick={() => run(() => deactivateUserAction({ id: userId, reason, lastDay, keysStopConfirmed: hasKeys && keysOk }), close)}>
          Turn off account
        </Button>
        <Button variant="secondary" onClick={() => setStep("form")}>
          Change last day or reason
        </Button>
        <Button variant="secondary" onClick={close}>
          Keep account
        </Button>
      </div>
    </div>
  );
}

export function AccessActions({
  userId,
  name,
  canResend,
  sent,
  today,
  apiKeys = [],
}: {
  userId: string;
  name: string;
  canResend: boolean;
  sent: boolean;
  /** Today's agency date (YYYY-MM-DD): the latest last day allowed. */
  today: string;
  /** An admin's API keys that still work: turning the account off stops them. */
  apiKeys?: Array<{ name: string; prefix: string }>;
}) {
  const { run, busy } = useCoordAction();
  return (
    <div className="flex flex-col gap-3">
      {canResend ? (
        <Button variant="secondary" busy={busy} onClick={() => run(() => resendInviteAction(userId))} className="w-fit">
          {sent ? "Resend invite" : "Send invite"}
        </Button>
      ) : null}
      <DepartureFlow userId={userId} name={name} today={today} apiKeys={apiKeys} />
    </div>
  );
}

/** Turns a departed account back on, with a reason. Old sign-ups stay removed. */
export function ReactivateForm({ userId, name }: { userId: string; name: string }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const { run, busy } = useCoordAction();
  if (!open)
    return (
      <Button variant="secondary" onClick={() => setOpen(true)} className="w-fit">
        Reactivate
      </Button>
    );
  return (
    <form
      aria-label={`Reactivate ${name}`}
      className="flex flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        run(() => reactivateUserAction({ id: userId, reason }), () => setOpen(false));
      }}
    >
      <FormField label="Reason" hint="Kept in the audit log. Old sign-ups are not restored; they make new calendar feeds and API keys.">
        <Input value={reason} onChange={(e) => setReason(e.target.value)} required maxLength={500} autoFocus />
      </FormField>
      <div className="flex flex-wrap gap-2">
        <Button type="submit" busy={busy}>
          Reactivate account
        </Button>
        <Button type="button" variant="secondary" onClick={() => setOpen(false)}>
          Close
        </Button>
      </div>
    </form>
  );
}

/** Writes off one unbilled detail of someone who left, with a reason. */
export function WriteOffDetail({ assignmentId, label }: { assignmentId: string; label: string }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const { run, busy } = useCoordAction();
  if (!open)
    return (
      <Button size="sm" variant="secondary" aria-label={`Write off ${label}`} onClick={() => setOpen(true)}>
        Write off
      </Button>
    );
  return (
    <form
      className="flex w-full flex-col gap-2 md:w-80"
      onSubmit={(e) => {
        e.preventDefault();
        run(() => writeOffDetailAction({ assignmentId, reason }), () => setOpen(false));
      }}
    >
      <FormField label={`Why write off ${label}`}>
        <Input value={reason} onChange={(e) => setReason(e.target.value)} required maxLength={500} autoFocus />
      </FormField>
      <div className="flex gap-2">
        <Button type="submit" size="sm" variant="danger" busy={busy}>
          Write off
        </Button>
        <Button type="button" size="sm" variant="secondary" onClick={() => setOpen(false)}>
          Close
        </Button>
      </div>
    </form>
  );
}
