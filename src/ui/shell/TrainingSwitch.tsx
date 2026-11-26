"use client";

import { useState } from "react";
import { Button } from "../components/Button";

export type TrainingRole = "deputy" | "coordinator" | "admin" | "vendor";
type Result = { ok: true } | { ok: false; error: string };

const ROLES: Array<{ value: TrainingRole; label: string }> = [
  { value: "deputy", label: "Deputy" },
  { value: "coordinator", label: "Coordinator" },
  { value: "admin", label: "Admin" },
  { value: "vendor", label: "Vendor" },
];

/** "Switch to training" in the coordinator menu: asks which role to practice as, then calls `switchMode`. */
export function TrainingSwitch({ switchMode }: Readonly<{ switchMode: (role: TrainingRole) => Promise<Result> }>) {
  const [open, setOpen] = useState(false);
  const [role, setRole] = useState<TrainingRole>("deputy");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!open)
    return (
      <Button size="sm" variant="secondary" onClick={() => setOpen(true)} aria-expanded={false}>
        Switch to training
      </Button>
    );
  return (
    <form
      className="flex flex-wrap items-center gap-2"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        const r = await switchMode(role).catch(() => ({ ok: false as const, error: "Could not switch. Try again." }));
        setBusy(false);
        if (r.ok) window.location.assign("/");
        else setError(r.error);
      }}
    >
      <fieldset className="m-0 flex items-center gap-2 border-0 p-0">
        <legend className="sr-only">Practice as</legend>
        {ROLES.map((r) => (
          <label key={r.value} className="flex min-h-9 items-center gap-1.5 text-sm pointer-coarse:min-h-11">
            <input type="radio" name="training-role" checked={role === r.value} onChange={() => setRole(r.value)} className="size-4 accent-accent" />
            {r.label}
          </label>
        ))}
      </fieldset>
      <Button type="submit" size="sm" busy={busy}>
        Start training
      </Button>
      <Button type="button" size="sm" variant="secondary" onClick={() => setOpen(false)}>
        Close
      </Button>
      {error ? (
        <p role="alert" className="m-0 w-full text-xs font-medium text-danger-ink">
          {error}
        </p>
      ) : null}
    </form>
  );
}

/** The training banner on every page while practicing ("TRAINING: practicing as Deputy"), with "Back to live". */
export function TrainingBanner({ roleLabel, backToLive }: Readonly<{ roleLabel: string; backToLive: () => Promise<Result> }>) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <section aria-label="Training mode" className="border-b border-warning-line bg-warning-soft text-warning-ink">
      <div className="mx-auto flex max-w-310 flex-wrap items-center justify-between gap-2 px-5 py-2 md:px-6">
        <p className="m-0 text-sm">
          <strong className="font-bold">TRAINING: practicing as {roleLabel}</strong>. Nothing here is real, and no email leaves training.
        </p>
        <Button
          size="sm"
          variant="secondary"
          busy={busy}
          onClick={async () => {
            setBusy(true);
            const r = await backToLive().catch(() => ({ ok: false as const, error: "Could not switch back. Try again." }));
            setBusy(false);
            if (r.ok) window.location.assign("/");
            else setError(r.error);
          }}
        >
          Back to live
        </Button>
        {error ? (
          <p role="alert" className="m-0 w-full text-xs font-medium">
            {error}
          </p>
        ) : null}
      </div>
    </section>
  );
}

/** "Back to live data" on the phone More page while practicing (the banner has the same action). */
export function BackToLiveButton({ backToLive }: Readonly<{ backToLive: () => Promise<Result> }>) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="flex flex-col gap-2">
      <Button
        busy={busy}
        onClick={async () => {
          setBusy(true);
          const r = await backToLive().catch(() => ({ ok: false as const, error: "Could not switch back. Try again." }));
          setBusy(false);
          if (r.ok) window.location.assign("/");
          else setError(r.error);
        }}
      >
        Back to live data
      </Button>
      {error ? (
        <p role="alert" className="m-0 text-xs font-medium text-danger-ink">
          {error}
        </p>
      ) : null}
    </div>
  );
}
