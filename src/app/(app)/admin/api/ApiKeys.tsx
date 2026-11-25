"use client";

import { useRef, useState } from "react";
import { Button } from "@/ui/components/Button";
import { Card, CardTitle } from "@/ui/components/Card";
import { Chip } from "@/ui/components/Chip";
import { EmptyState } from "@/ui/components/EmptyState";
import { FormField, Input } from "@/ui/components/FormField";
import { Notice } from "@/ui/components/Notice";
import { Icon } from "@/ui/icons";
import { useCoordAction } from "../../coordinate/_coordinator/status";
import { createApiKeyAction, revokeApiKeyAction, type NewKeyForm } from "./actions";

export type KeyRow = {
  id: string;
  name: string;
  prefix: string;
  scopes: string[];
  createdBy: string;
  created: string;
  lastUsed: string | null;
  expires: string | null;
  expired: boolean;
  revoked: string | null;
};

const MONO = "[font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace]";
const BLANK: NewKeyForm = { name: "", access: "read", w9: false, expiresOn: "" };

function Choice({ name, value, checked, onChange, title, hint }: { name: string; value: string; checked: boolean; onChange: () => void; title: string; hint: string }) {
  return (
    <label className={`flex cursor-pointer items-start gap-3 rounded-md p-3 ${checked ? "border-2 border-accent" : "border border-line"}`}>
      <input type="radio" name={name} value={value} checked={checked} onChange={onChange} className="mt-0.5 size-4.5 shrink-0 accent-accent" />
      <span className="flex flex-col gap-0.5">
        <span className="font-semibold">{title}</span>
        <span className="text-sm text-muted">{hint}</span>
      </span>
    </label>
  );
}

/** The one time a new key is shown: the whole key, a copy button and the warning that it will not be shown again. */
function NewKey({ value, onDone }: { value: string; onDone: () => void }) {
  const field = useRef<HTMLInputElement>(null);
  const [copied, setCopied] = useState<"yes" | "select" | null>(null);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied("yes");
    } catch {
      field.current?.select();
      setCopied("select");
    }
  };
  return (
    <Card tone="accent" aria-labelledby="new-key-title">
      <CardTitle>
        <span id="new-key-title">Copy your new key</span>
      </CardTitle>
      <Notice tone="warning" as="div">
        You will not see this key again. Store it in the system that will use it before you leave this page. If it is lost, revoke it and make another.
      </Notice>
      <div className="flex flex-col gap-2 sm:flex-row">
        <label htmlFor="new-key" className="sr-only">
          New API key
        </label>
        <input
          ref={field}
          id="new-key"
          readOnly
          value={value}
          onFocus={(e) => e.currentTarget.select()}
          className={`h-11 min-w-0 flex-1 rounded-sm border border-field bg-subtle px-3 text-sm text-ink focus-visible:border-focus focus-visible:outline-2 focus-visible:outline-focus ${MONO}`}
        />
        <Button type="button" onClick={copy} className="shrink-0">
          <Icon name={copied === "yes" ? "check" : "copy"} size={18} />
          {copied === "yes" ? "Copied" : "Copy key"}
        </Button>
      </div>
      <p role="status" className="m-0 min-h-5 text-sm text-muted">
        {copied === "yes" ? "The key is on your clipboard." : copied === "select" ? "Copying is blocked here. The key is selected: press Ctrl+C or Command+C." : ""}
      </p>
      <p className="m-0 text-sm text-muted">
        Send it as <code className={`text-ink ${MONO}`}>Authorization: Bearer</code> followed by the key.
      </p>
      <Button type="button" variant="secondary" onClick={onDone} className="w-fit">
        I stored the key
      </Button>
    </Card>
  );
}

export function CreateKey() {
  const [f, setF] = useState<NewKeyForm>(BLANK);
  const [made, setMade] = useState<string | null>(null);
  const { run, busy, error } = useCoordAction();
  if (made) return <NewKey value={made} onDone={() => setMade(null)} />;
  const nameError = error && !error.ok && /name/i.test(error.error) ? error.error : undefined;
  return (
    <Card aria-labelledby="create-key-title">
      <CardTitle>
        <span id="create-key-title">Make a key</span>
      </CardTitle>
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          run(
            () => createApiKeyAction(f),
            (r) => {
              if (r.value) setMade(r.value);
              setF(BLANK);
            },
          );
        }}
      >
        <FormField label="Name" hint="The system that will use it, such as Payroll export." error={nameError}>
          <Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} maxLength={100} autoComplete="off" required />
        </FormField>
        <fieldset className="m-0 flex flex-col gap-2 border-0 p-0">
          <legend className="mb-1.5 p-0 text-sm font-medium text-muted">Access</legend>
          <Choice name="access" value="read" checked={f.access === "read"} onChange={() => setF({ ...f, access: "read" })} title="Read only" hint="Reads every record and the full export. Cannot change anything." />
          <Choice
            name="access"
            value="write"
            checked={f.access === "write"}
            onChange={() => setF({ ...f, access: "write" })}
            title="Read and write"
            hint="Also makes changes, under the same rules and audit as the app."
          />
        </fieldset>
        <label className="flex cursor-pointer items-start gap-3">
          <input type="checkbox" checked={f.w9} onChange={(e) => setF({ ...f, w9: e.target.checked })} className="mt-0.5 size-4.5 shrink-0 accent-accent" />
          <span className="flex flex-col gap-0.5">
            <span className="font-semibold">W-9 downloads</span>
            <span className="text-sm text-muted">Leave off unless the system must read tax forms. Every read is logged.</span>
          </span>
        </label>
        <FormField label="Expires (optional)" hint="The key stops working at the end of this day. Leave blank for no expiry.">
          <Input type="date" value={f.expiresOn} onChange={(e) => setF({ ...f, expiresOn: e.target.value })} />
        </FormField>
        <Button type="submit" busy={busy} className="w-fit">
          Make key
        </Button>
      </form>
    </Card>
  );
}

function access(scopes: string[]) {
  return scopes.includes("write") ? "Read and write" : "Read only";
}

function Revoke({ row }: { row: KeyRow }) {
  const [asking, setAsking] = useState(false);
  const { run, busy } = useCoordAction();
  if (!asking)
    return (
      <Button type="button" size="sm" variant="secondary" onClick={() => setAsking(true)} aria-label={`Revoke ${row.name}`}>
        Revoke
      </Button>
    );
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-sm">Systems using it stop at once.</span>
      <Button type="button" size="sm" variant="danger" busy={busy} onClick={() => run(() => revokeApiKeyAction(row.id))}>
        Revoke {row.name}
      </Button>
      <Button type="button" size="sm" variant="secondary" onClick={() => setAsking(false)}>
        Keep it
      </Button>
    </div>
  );
}

export function KeyList({ rows }: { rows: KeyRow[] }) {
  const live = rows.filter((r) => !r.revoked);
  return (
    <Card pad={false} aria-labelledby="keys-title">
      <div className="flex items-center gap-2 px-4 pt-4 md:px-5.5 md:pt-5.5">
        <CardTitle>
          <span id="keys-title">Keys</span>
        </CardTitle>
        <span className="inline-flex h-5.5 min-w-5.5 items-center justify-center rounded-full bg-accent-soft px-2 text-xs font-semibold text-link" data-numeric>
          {live.length}
          <span className="sr-only"> in use</span>
        </span>
      </div>
      {rows.length === 0 ? (
        <div className="p-4 md:p-5.5">
          <EmptyState title="No keys yet">Make one for each system that reads or writes data.</EmptyState>
        </div>
      ) : (
        <ul className="m-0 mt-2 list-none divide-y divide-divider border-t border-divider p-0">
          {rows.map((r) => (
            <li key={r.id} className={`flex flex-wrap items-start justify-between gap-3 px-4 py-3.25 md:px-5.5 ${r.revoked ? "text-muted" : ""}`}>
              <div className="flex min-w-0 flex-col gap-1">
                <span className="flex flex-wrap items-center gap-2">
                  <span className={`font-semibold ${r.revoked ? "" : "text-ink"}`}>{r.name}</span>
                  <Chip tone={r.scopes.includes("write") ? "attention" : "info"}>{access(r.scopes)}</Chip>
                  {r.scopes.includes("w9") ? <Chip tone="warning">W-9 downloads</Chip> : null}
                  {r.revoked ? <Chip tone="neutral">Revoked {r.revoked}</Chip> : r.expired ? <Chip tone="danger">Expired</Chip> : null}
                </span>
                <span className={`text-sm ${MONO}`}>
                  {r.prefix}
                  <span aria-hidden="true">...</span>
                  <span className="sr-only">, the rest is hidden</span>
                </span>
                <span className="text-sm text-muted">
                  {r.lastUsed ? `Last used ${r.lastUsed}` : "Never used"}. {r.expires ? `${r.expired ? "Expired" : "Expires"} ${r.expires}` : "No expiry"}. Made {r.created} by {r.createdBy}.
                </span>
              </div>
              {r.revoked ? null : <Revoke row={r} />}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
