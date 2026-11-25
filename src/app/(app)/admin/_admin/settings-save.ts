import type { $ZodIssue } from "zod/v4/core";
import type { Tx } from "@/db/client";
import type { Actor } from "@/domain/actor";
import { agencySettingsSchema, getSettings, rateRangeProblems, saveSettings, type SettingsPatch } from "@/domain/settings/settings";
import { normalizePhone } from "@/lib/phone";
import { PHONE_MESSAGE } from "@/domain/phone";
import type { ActionResult } from "../../_personnel/result";
import { getPath, type Field, type Group, type GroupValues } from "./settings-groups";

function setPath(obj: Record<string, unknown>, key: string, value: unknown): void {
  const parts = key.split(".");
  let o = obj;
  for (const p of parts.slice(0, -1)) o = (o[p] ??= {}) as Record<string, unknown>;
  o[parts[parts.length - 1]] = value;
}

/** A typed value as the schema expects it. Anything unreadable becomes NaN, which the schema refuses. */
function convert(f: Field, v: unknown): unknown {
  const s = typeof v === "string" ? v.trim() : "";
  switch (f.kind) {
    case "int":
      return /^-?\d+$/.test(s) ? Number(s) : s === "" ? Number.NaN : Number(s);
    case "hours":
      return /^\d{1,4}(\.\d{1,2})?$/.test(s) ? Math.round(Number(s) * 60) : Number.NaN;
    case "float":
      return s !== "" && Number.isFinite(Number(s)) ? Number(s) : Number.NaN;
    case "dollarsOptional":
    case "dollars": {
      const t = s.replace(/[$,\s]/g, "");
      if (f.kind === "dollarsOptional" && t === "") return null;
      if (f.blankIsZero && t === "") return 0;
      if (!/^\d{1,6}(\.\d{1,2})?$/.test(t)) return Number.NaN;
      const [whole, cents = ""] = t.split(".");
      return Number(whole) * 100 + Number(cents.padEnd(2, "0"));
    }
    case "weekday":
      return /^[0-6]$/.test(s) ? Number(s) : Number.NaN;
    case "switch":
      return v === true;
    case "reviewers":
      return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
    case "positionType":
      return s || null;
    default:
      return typeof v === "string" ? v : "";
  }
}

/** A schema limit in the unit the field is typed in (hours fields store minutes). */
const shown = (f: Field, limit: unknown) => (f.kind === "hours" ? String(Math.round((Number(limit) / 60) * 100) / 100) : String(limit));

/** A plain message for one schema issue on one field. */
function message(f: Field, i: $ZodIssue): string {
  switch (i.code) {
    case "too_small":
      return i.origin === "string" || i.origin === "array" ? "This is required." : `Enter ${shown(f, i.minimum)} or more.`;
    case "too_big":
      return i.origin === "string" ? `Use at most ${String(i.maximum)} characters.` : `Enter ${shown(f, i.maximum)} or less.`;
    case "invalid_format":
      return i.format === "email" ? "Enter an email address, or leave it blank." : (f.formatHint ?? "Check the format.");
    case "invalid_union":
      return f.kind === "email" ? "Enter an email address, or leave it blank." : "Check this value.";
    case "invalid_value":
      return "Choose one of the options.";
    case "invalid_type":
      return f.formatHint ?? (f.kind === "int" ? "Enter a whole number." : f.kind === "float" ? "Enter a number." : "Check this value.");
    default:
      return f.formatHint ?? "Check this value.";
  }
}

/**
 * Saves one group. The whole settings object is checked with the agency settings schema first, so every bad
 * field is reported beside itself and nothing is saved. A changed release day or time moves the release
 * dates of details that have not opened yet.
 */
export async function saveGroup(actor: Actor, tx: Tx, group: Group, values: GroupValues): Promise<ActionResult> {
  const before = await getSettings(tx);
  const patch: Record<string, unknown> = {};
  for (const f of group.fields) setPath(patch, f.key, convert(f, values[f.key]));

  const candidate = structuredClone(before) as unknown as Record<string, unknown>;
  for (const f of group.fields) setPath(candidate, f.key, getPath(patch, f.key));
  const phoneErrors: Record<string, string> = {};
  for (const f of group.fields) {
    const v = typeof values[f.key] === "string" ? (values[f.key] as string).trim() : "";
    // An unchanged number saved before the phone rule never blocks the rest of the form.
    if (f.kind === "phone" && v && v !== String(getPath(before, f.key) ?? "").trim() && !normalizePhone(v)) phoneErrors[f.key] = `${PHONE_MESSAGE}.`;
  }
  const parsed = agencySettingsSchema.safeParse(candidate);
  if (Object.keys(phoneErrors).length) {
    const fields: Record<string, string> = { ...phoneErrors };
    if (!parsed.success) for (const issue of parsed.error.issues) {
      const key = issue.path.join(".");
      const f = group.fields.find((x) => x.key === key || key.startsWith(`${x.key}.`));
      if (f && !fields[f.key]) fields[f.key] = message(f, issue);
    }
    return { ok: false, error: "Check the highlighted fields. Nothing was saved.", fields };
  }
  if (!parsed.success) {
    const fields: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      const key = issue.path.join(".");
      const f = group.fields.find((x) => x.key === key || key.startsWith(`${x.key}.`));
      if (f && !fields[f.key]) fields[f.key] = message(f, issue);
    }
    if (Object.keys(fields).length) return { ok: false, error: "Check the highlighted fields. Nothing was saved.", fields };
  } else {
    const keys = new Set(group.fields.map((f) => f.key));
    const problems = (await rateRangeProblems(tx, before, parsed.data)).filter((p) => keys.has(p.key));
    if (problems.length) return { ok: false, error: "Check the highlighted fields. Nothing was saved.", fields: Object.fromEntries(problems.map((p) => [p.key, p.message])) };
  }

  const { releaseDatesMoved: moved } = await saveSettings(actor, tx, patch as SettingsPatch);
  if (moved !== null) {
    return {
      ok: true,
      message: moved === 0 ? "Saved. No release dates changed." : `Saved. ${moved} ${moved === 1 ? "detail now opens" : "details now open"} on the new release date.`,
    };
  }
  return { ok: true, message: group.saved };
}
