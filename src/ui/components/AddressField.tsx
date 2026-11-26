"use client";

import { useEffect, useId, useRef, useState } from "react";
import { addressDecision, withUnit } from "@/lib/address-match";
import { Button } from "./Button";
import { Chip } from "./Chip";
import { Input, TextArea } from "./FormField";
import { useMapConfig } from "./MapConfig";
import type { AddressValue } from "./address-value";
import { PinPicker } from "./PinPicker";

export { addressValue, pinWire, type AddressValue } from "./address-value";

const LOOKUP_TIMEOUT_MS = 8000;

type Lookup = { status: string; match: { label: string; lat: number; lng: number } | null };

async function lookup(q: string): Promise<Lookup | null> {
  try {
    const res = await fetch(`/api/v1/geocode?q=${encodeURIComponent(q)}`, { signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS) });
    if (!res.ok) return null;
    return (await res.json()).data ?? null;
  } catch {
    return null;
  }
}

/** The field once the lookup of `q` answered: verified (the pin follows unless placed by hand), a suggestion, or not verified. */
function afterLookup(now: AddressValue, q: string, r: Lookup | null): AddressValue {
  const found = r?.status === "match" ? r.match : null;
  // A suite or unit the person typed stays in the suggestion (the map never has one).
  const match = found ? { ...found, label: withUnit(q, found.label) } : null;
  const decision = addressDecision(q, match);
  const keepManual = now.pin === "manual";
  if (decision === "verified" && match) {
    return { ...now, state: "verified", suggestion: null, ...(keepManual ? {} : { lat: match.lat, lng: match.lng, pin: "auto" as const }) };
  }
  if (decision === "suggest" && match) return { ...now, state: "suggest", suggestion: match };
  return { ...now, state: "unverified", suggestion: null, unavailable: !r || r.status === "unavailable" };
}

/** What the lookup found, with the choice between a suggestion and the typed address. */
function LookupStatus({
  id,
  value,
  onUseSuggested,
  onKeepTyped,
}: Readonly<{ id: string; value: AddressValue; onUseSuggested: () => void; onKeepTyped: () => void }>) {
  return (
    <output id={id} aria-live="polite" className="flex flex-col gap-1.5 empty:hidden">
      {value.state === "checking" ? <p className="m-0 text-xs text-muted">Looking up the address.</p> : null}
      {value.state === "verified" ? <p className="m-0 text-xs font-medium text-success-ink">Found on the map.</p> : null}
      {value.state === "unverified" ? (
        <p className="m-0 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
          <Chip tone="warning">Not verified</Chip>
          <span>{value.unavailable ? "The address lookup did not answer. It saves as typed." : "Saved as typed. Check it before deputies rely on it."}</span>
        </p>
      ) : null}
      {value.state === "suggest" && value.suggestion ? (
        <div className="flex flex-col gap-2 rounded-md border border-line bg-subtle px-3 py-2.5">
          <p className="m-0 text-sm">
            <span className="text-muted">Did you mean </span>
            <span className="font-semibold">{value.suggestion.label}</span>
          </p>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" onClick={onUseSuggested}>
              Use suggested
            </Button>
            <Button size="sm" variant="secondary" onClick={onKeepTyped}>
              Keep as entered
            </Button>
          </div>
        </div>
      ) : null}
      {value.state !== "idle" ? (
        <p className="m-0 text-micro text-muted">
          Address search by{" "}
          <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer noopener">
            OpenStreetMap
          </a>
        </p>
      ) : null}
    </output>
  );
}

/**
 * An address input that looks the address up on OpenStreetMap when the person leaves it. A different match is
 * offered as "Did you mean"; no match, a failed lookup or "Keep as entered" shows Not verified. With `pin`, a map
 * with a draggable pin follows, and a pin placed by hand wins over the lookup. Nothing here ever blocks saving.
 */
export function AddressField({
  label,
  hint,
  value,
  onChange,
  pin = false,
  multiline = false,
  required,
  maxLength = 300,
  id: givenId,
}: Readonly<{
  label: string;
  hint?: string;
  value: AddressValue;
  onChange: (v: AddressValue) => void;
  pin?: boolean;
  multiline?: boolean;
  required?: boolean;
  maxLength?: number;
  id?: string;
}>) {
  const auto = useId();
  const id = givenId ?? auto;
  const hintId = `${id}-hint`;
  const statusId = `${id}-status`;
  const map = useMapConfig();
  const checked = useRef(value.address.trim());
  const latest = useRef(value);
  latest.current = value;
  // The lookup answers after other fields may have changed: always report through the newest onChange.
  const report = useRef(onChange);
  report.current = onChange;
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const check = async () => {
    const q = latest.current.address.trim();
    if (!q || q === checked.current) return;
    checked.current = q;
    report.current({ ...latest.current, state: "checking", suggestion: null, unavailable: false });
    const r = await lookup(q);
    const now = latest.current;
    if (now.address.trim() !== q) return;
    report.current(afterLookup(now, q, r));
  };

  const edit = (text: string) => {
    // A changed address makes any earlier pin stale, a hand-placed one included, and is looked up again on leaving.
    checked.current = "";
    onChange({ address: text, lat: null, lng: null, pin: null, state: "idle", suggestion: null });
  };

  const useSuggested = () => {
    const s = value.suggestion;
    if (!s) return;
    checked.current = s.label;
    onChange({ address: s.label, lat: value.pin === "manual" ? value.lat : s.lat, lng: value.pin === "manual" ? value.lng : s.lng, pin: value.pin === "manual" ? "manual" : "auto", state: "verified", suggestion: null });
  };
  const keepTyped = () => onChange({ ...value, state: "unverified", suggestion: null, unavailable: false });

  const describedBy = [hint ? hintId : null, value.state !== "idle" ? statusId : null].filter(Boolean).join(" ") || undefined;
  const control = {
    id,
    value: value.address,
    required,
    maxLength,
    autoComplete: "street-address",
    "aria-describedby": describedBy,
    onBlur: () => void check(),
  };
  const showPin = pin && map && mounted && value.address.trim() !== "" && value.state !== "checking" && value.state !== "suggest";

  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-sm font-medium text-muted">
        {label}
      </label>
      {multiline ? <TextArea {...control} onChange={(e) => edit(e.target.value)} className="min-h-18" /> : <Input {...control} onChange={(e) => edit(e.target.value)} />}
      {hint ? (
        <p id={hintId} className="m-0 text-xs text-muted">
          {hint}
        </p>
      ) : null}
      <LookupStatus id={statusId} value={value} onUseSuggested={useSuggested} onKeepTyped={keepTyped} />
      {showPin ? (
        <>
          <PinPicker
            config={map}
            point={value.lat !== null && value.lng !== null ? { lat: value.lat, lng: value.lng } : null}
            onMove={(p) => report.current({ ...latest.current, lat: p.lat, lng: p.lng, pin: "manual" })}
            label={`${label} pin`}
          />
          {value.pin === "manual" ? <p className="m-0 text-xs text-muted">Pin placed by hand. It is used instead of the address lookup.</p> : null}
        </>
      ) : null}
    </div>
  );
}
