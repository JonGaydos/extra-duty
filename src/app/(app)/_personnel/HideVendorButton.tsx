"use client";

import { hideVendorAction, unhideVendorAction } from "./actions";
import { ActionStatus, useAction } from "./use-action";

/** "Hide this vendor": takes the vendor off the person's open lists (never off details they are on). */
export function HideVendorButton({ vendorId, vendorName, undo = false, compact = false }: Readonly<{ vendorId: string; vendorName: string; undo?: boolean; compact?: boolean }>) {
  const { run, busy, result } = useAction();
  const label = undo ? "Show again" : "Hide this vendor";
  return (
    <span className="inline-flex flex-col gap-1.5">
      <button
        type="button"
        disabled={busy}
        aria-busy={busy || undefined}
        aria-label={compact ? `${label}: ${vendorName}` : undefined}
        onClick={() => run(() => (undo ? unhideVendorAction(vendorId) : hideVendorAction(vendorId)))}
        className="inline-flex min-h-8 w-fit items-center rounded-sm px-1 text-sm font-semibold text-link hover:text-link-hover hover:underline disabled:opacity-55 pointer-coarse:min-h-11"
      >
        {undo || compact ? label : "Hide this vendor from my lists"}
      </button>
      <ActionStatus result={result} />
    </span>
  );
}
