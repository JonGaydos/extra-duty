import { useState } from "react";
import type { ActionResult } from "../../_personnel/result";

/** The engine's schedule checks a time change can fail for deputies already on a detail. */
export const CONFLICT_CHECKS = new Set(["overlap", "cap_rolling", "cap_week", "cap_month", "schedule.window"]);

/** Edit fields that can change which deputies conflict: times, the flexible window, the date and the scope. */
const CONFLICT_FIELDS = new Set(["startTime", "endTime", "flex", "date", "scope"]);

/** Whether changing `field` makes the listed conflicts stale (hide them and drop a confirmed override). */
export const clearsConflicts = (field: string) => CONFLICT_FIELDS.has(field);

export type ConflictOverrideWire = { reason: string; fingerprints: Record<string, string> };

/**
 * What to show and send for a deputy-conflict override. Conflicts come from the last refused save; once the edit
 * changes (`dirty`) they are stale, so nothing is shown and no override is sent until the next save lists them
 * again. An override needs the confirmation and a reason, and carries the fingerprints the server listed.
 */
export function conflictGuard(s: { result: ActionResult | null; dirty: boolean; confirmed: boolean; reason: string }): { conflicts: string[]; override: ConflictOverrideWire | null } {
  const shown = !s.dirty && s.result && !s.result.ok ? s.result : null;
  const conflicts = shown ? (shown.checks ?? []).filter((c) => CONFLICT_CHECKS.has(c.check)).map((c) => c.message) : [];
  const override = conflicts.length && s.confirmed && s.reason.trim() ? { reason: s.reason, fingerprints: { ...(shown!.fields ?? {}) } } : null;
  return { conflicts, override };
}

/** State for one editor: call `touch()` on every change to the edit and `submitted()` when saving. */
export function useConflictGuard(result: ActionResult | null) {
  const [dirty, setDirty] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [reason, setReason] = useState("");
  const g = conflictGuard({ result, dirty, confirmed, reason });
  return {
    ...g,
    confirmed,
    touch: () => {
      setDirty(true);
      setConfirmed(false);
      setReason("");
    },
    submitted: () => setDirty(false),
    reset: () => {
      setConfirmed(false);
      setReason("");
    },
    props: { conflicts: g.conflicts, confirmed, onConfirmed: setConfirmed, reason, onReason: setReason },
  };
}
