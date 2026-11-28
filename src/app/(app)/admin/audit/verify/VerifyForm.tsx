"use client";

import { useState } from "react";
import { Button } from "@/ui/components/Button";
import { Card } from "@/ui/components/Card";
import { FormField, Input } from "@/ui/components/FormField";
import { Notice } from "@/ui/components/Notice";
import { verifyRecordAction, type VerifyView } from "./actions";

/** Paste or scan the record ID, optionally with the printed integrity code, and see whether the record still matches. */
export function VerifyForm() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<VerifyView | null>(null);
  return (
    <div className="flex flex-col gap-4.5">
      <Card>
        <form
          className="flex flex-col gap-3"
          onSubmit={async (e) => {
            e.preventDefault();
            const data = new FormData(e.currentTarget);
            setBusy(true);
            setError(null);
            setView(null);
            const field = (k: string) => {
              const v = data.get(k);
              return typeof v === "string" ? v : "";
            };
            const r = await verifyRecordAction(field("recordId"), field("integrity")).catch(() => ({ ok: false as const, error: "That did not go through. Check your connection and try again." }));
            setBusy(false);
            if (r.ok) setView(r.view);
            else setError(r.error);
          }}
        >
          <FormField label="Record ID" hint="Printed on the cover and in every page footer, such as AR-000012.">
            <Input name="recordId" required autoComplete="off" autoCapitalize="characters" className="md:w-72" />
          </FormField>
          <FormField label="Integrity code (optional)" hint="Paste or type the 64-character code from the printed copy to compare it too.">
            <Input name="integrity" autoComplete="off" spellCheck={false} className="font-mono" />
          </FormField>
          <Button type="submit" busy={busy} className="w-fit">
            Check the record
          </Button>
        </form>
      </Card>
      <output aria-live="polite" className="block empty:hidden">
        {error ? (
          <Notice tone="danger" as="div">
            {error}
          </Notice>
        ) : null}
        {view ? (
          <Card tone={view.matches && view.printedMatches !== false ? "default" : "danger"} data-testid="verify-result">
            <h2 className="m-0 text-title font-semibold md:text-base">{view.headline}</h2>
            <ul className="m-0 flex flex-col gap-1 pl-5 text-sm">
              {view.lines.map((l) => (
                <li key={l}>{l}</li>
              ))}
            </ul>
            <p className="m-0 text-xs break-all text-muted">
              Integrity code on record: <code>{view.integrity}</code>
            </p>
          </Card>
        ) : null}
      </output>
    </div>
  );
}
