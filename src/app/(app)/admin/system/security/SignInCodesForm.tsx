"use client";

import { useState } from "react";
import { Button } from "@/ui/components/Button";
import { Notice } from "@/ui/components/Notice";
import { Icon } from "@/ui/icons";
import { ActionStatus, useAction } from "../../../_personnel/use-action";
import { Switch } from "../../_admin/forms";
import { saveSignInCodesAction, type SignInCodes } from "../_system/actions";

const ROLES = [
  { key: "coordinator", label: "Coordinators" },
  { key: "personnel", label: "Deputies" },
  { key: "vendor", label: "Vendors" },
] as const;

type Role = (typeof ROLES)[number]["key"];

/**
 * "Require emailed sign-in codes" for each role. Admins are locked on, with the reason. Turning a role off asks for
 * confirmation first, inline, with what is at stake.
 */
export function SignInCodesForm({ initial, adminReason }: Readonly<{ initial: SignInCodes; adminReason: string }>) {
  const [codes, setCodes] = useState<SignInCodes>(initial);
  const [confirming, setConfirming] = useState(false);
  const { run, busy, result } = useAction();
  const turningOff = ROLES.filter((r) => initial[r.key] && !codes[r.key]).map((r) => r.label);
  const changed = ROLES.some((r) => initial[r.key] !== codes[r.key]);

  const set = (role: Role, on: boolean) => {
    setConfirming(false);
    setCodes({ ...codes, [role]: on });
  };
  const save = () => run(() => saveSignInCodesAction(codes), () => setConfirming(false));

  return (
    <form
      aria-label="Require emailed sign-in codes"
      className="flex flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (turningOff.length) setConfirming(true);
        else save();
      }}
    >
      <div className="flex items-center justify-between gap-3 rounded-md border border-line bg-subtle px-3.5 py-2.5">
        <span className="flex flex-col">
          <span className="font-medium">Admins</span>
          <span id="admin-codes-reason" className="text-xs text-muted">
            Always required. {adminReason}
          </span>
        </span>
        <span className="inline-flex shrink-0 items-center gap-1.5 text-sm font-semibold text-muted">
          <Icon name="lock" size={18} />
          Required
        </span>
      </div>
      {ROLES.map((r) => (
        <Switch key={r.key} label={r.label} checked={codes[r.key]} onChange={(on) => set(r.key, on)} />
      ))}
      {confirming ? (
        <section aria-label="Confirm sign-in without a code" className="flex flex-col gap-3">
          <Notice tone="danger" as="div">
            <p className="m-0 font-semibold">{turningOff.join(" and ")} will sign in with a password alone.</p>
            <p className="m-0 mt-1">
              This site holds W-9s with Social Security numbers and pay records. Without a code, a guessed, reused or stolen password is enough to open them. The change applies at each
              person&apos;s next sign-in; anyone already signed in stays signed in. It is recorded in the audit log.
            </p>
          </Notice>
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="danger" busy={busy} onClick={save}>
              Turn off codes for {turningOff.join(" and ")}
            </Button>
            <Button type="button" variant="secondary" onClick={() => setConfirming(false)}>
              Keep codes on
            </Button>
          </div>
        </section>
      ) : (
        <Button type="submit" busy={busy} disabled={!changed} className="w-fit">
          Save sign-in codes
        </Button>
      )}
      <ActionStatus result={result} />
    </form>
  );
}
