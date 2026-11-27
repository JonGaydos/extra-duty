"use client";

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import type { DetailFormOptions } from "@/domain/coordinator/views";
import { resolveMinimum } from "@/domain/billing/rules";
import { Button } from "@/ui/components/Button";
import { Card, CardTitle } from "@/ui/components/Card";
import { FormField, Input, Select, TextArea } from "@/ui/components/FormField";
import { Notice } from "@/ui/components/Notice";
import { PayLabel, dollars } from "@/ui/components/PayLabel";
import { createDetailsAction, suggestPlanAction } from "../../coordinate/_coordinator/actions";
import { DatesStep, keyLabel } from "../../coordinate/_coordinator/DatesStep";
import { FlexFields, PreviewRow, SafetyAddressFields, safetyRows, safetyWire, type TimeOverride as Override } from "../../coordinate/_coordinator/DetailFields";
import type { DetailWire } from "../../coordinate/_coordinator/detail-input";
import { useCoordAction } from "../../coordinate/_coordinator/status";
import { AddPositionRow } from "../../coordinate/_coordinator/EditPanel";
import { RateRangeNotice } from "../../coordinate/_coordinator/RateRangeNotice";
import { SiteContactFields } from "../../coordinate/_coordinator/SiteContactFields";
import { addPosition, changePositionType, detailSummary, spanMinutes } from "../../coordinate/_coordinator/detail-summary";
import { useRowKeys } from "@/ui/use-row-keys";

const minutesOf = (t: string) => (/^\d{2}:\d{2}$/.test(t) ? Number(t.slice(0, 2)) * 60 + Number(t.slice(3)) : null);
const DATE_ERROR = /^(\d{4}-\d{2}-\d{2}): (.*)$/;
const RELEASE = new Intl.DateTimeFormat("en-US", { timeZone: "America/Chicago", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

type Summary = ReturnType<typeof detailSummary>;

/** Typed dollars as cents; anything unreadable falls back to the vendor's or the agency's default rate. */
function typedRate(rate: string, fallback: number): number {
  const t = rate.replace(/[$,\s]/g, "");
  if (/^\d{1,5}(\.\d{1,2})?$/.test(t)) {
    const [w, c = ""] = t.split(".");
    return Number(w) * 100 + Number(c.padEnd(2, "0"));
  }
  return fallback;
}

/** When the first date opens for sign-up. */
function releaseLine(held: boolean, release: string | undefined): string {
  if (held) return "Held until you release it";
  if (!release) return "Choose a date";
  const at = RELEASE.format(new Date(release));
  return new Date(release).getTime() <= Date.now() ? `Opens now (released ${at})` : `Opens ${at}`;
}

/** One deputy's pay, or the range when it differs between dates or positions. */
function EachEarns({ low, high }: Readonly<{ low: Summary["low"]; high: Summary["high"] }>) {
  if (!low || !high) return <>Set the times</>;
  if (low.totalCents === high.totalCents && low.rateCents === high.rateCents) return <PayLabel variant="plain" totalCents={low.totalCents} rateCents={low.rateCents} />;
  return (
    <>
      <PayLabel variant="plain" totalCents={low.totalCents} rateCents={low.rateCents} />
      <span className="text-sm text-muted">to</span>
      <PayLabel variant="plain" totalCents={high.totalCents} rateCents={high.rateCents} />
    </>
  );
}

/** The summary beside the form: release, pay, dates with their own times, the vendor total, and Create. */
function SummaryCard({ releaseText, summary, n, overrides, chosen, busy }: Readonly<{ releaseText: string; summary: Summary; n: number; overrides: Record<string, Override>; chosen: string[]; busy: boolean }>) {
  return (
    <Card tone="accent" className="md:sticky md:top-6">
      <CardTitle>Summary</CardTitle>
      <dl className="m-0 flex flex-col gap-2 text-body">
        <div className="flex justify-between gap-3">
          <dt className="text-muted">Release</dt>
          <dd className="m-0 text-right">{releaseText}</dd>
        </div>
        <div className="flex justify-between gap-3">
          <dt className="text-muted">Each deputy earns</dt>
          <dd className="m-0 flex flex-col items-end text-right" data-testid="summary-each">
            <EachEarns low={summary.low} high={summary.high} />
          </dd>
        </div>
        {n > 1 && Object.keys(overrides).some((k) => chosen.includes(k)) ? (
          <div className="flex flex-col gap-1">
            <dt className="text-muted">Dates with their own times</dt>
            {summary.perDate
              .filter((x) => x.date && overrides[x.date])
              .map((x) => (
                <dd key={x.date} className="m-0 flex justify-between gap-3 text-sm">
                  <span>{keyLabel(x.date!)}</span>
                  {x.low && x.high ? <PayLabel variant="plain" totalCents={x.low.totalCents} rateCents={x.low.rateCents} upTo={x.high} /> : <span>Set the times</span>}
                </dd>
              ))}
          </div>
        ) : null}
        <div className="flex justify-between gap-3">
          <dt className="text-muted">Vendor total{n > 1 ? `, ${n} dates` : ""}</dt>
          <dd className="m-0 text-right font-semibold" data-numeric data-testid="summary-total">
            {summary.vendorTotalCents !== null ? dollars(summary.vendorTotalCents) : "Set the times"}
          </dd>
        </div>
      </dl>
      <p className="m-0 text-sm text-muted">No alert goes out when it posts. Deputies find it in the app once it opens.</p>
      <Button type="submit" size="lg" full busy={busy} disabled={n === 0}>
        {n <= 1 ? "Create detail" : `Create ${n} details`}
      </Button>
      {n === 0 ? <p className="m-0 text-xs text-muted">Choose at least one date.</p> : null}
    </Card>
  );
}

/**
 * New detail: vendor and place, when (times plus the Dates step and a preview of every date), positions, pay,
 * officer safety, ops plan and release. One save creates every date as a single series, or nothing.
 */
export function DetailForm({ options, initial, today, fromJobId, fromTitle }: Readonly<{ options: DetailFormOptions; initial: DetailWire; today: string; fromJobId?: string; fromTitle?: string }>) {
  const router = useRouter();
  const [d, setD] = useState<DetailWire>(initial);
  const positionKeys = useRowKeys(d.positions);
  const [safety, setSafety] = useState(() => safetyRows(initial.safetyAddresses));
  const [dates, setDates] = useState<string[]>([]);
  const [removed, setRemoved] = useState<Set<string>>(new Set());
  const [overrides, setOverrides] = useState<Record<string, Override>>({});
  const [dateErrors, setDateErrors] = useState<Record<string, string>>({});
  const [copyAttachments, setCopyAttachments] = useState(true);
  const [plan, setPlan] = useState<{ year: number; title: string; versionId: string; filename: string } | null>(null);
  const { run, busy } = useCoordAction();
  const set = <K extends keyof DetailWire>(k: K, v: DetailWire[K]) => setD((x) => ({ ...x, [k]: v }));

  const chosen = useMemo(() => dates.filter((x) => !removed.has(x)), [dates, removed]);
  const vendor = options.vendors.find((v) => v.id === d.vendorId);
  const locations = options.locations.filter((l) => l.vendorId === d.vendorId);
  const contacts = options.contacts.filter((c) => c.vendorId === d.vendorId);

  useEffect(() => {
    if (!d.opsPlanRequired || !d.vendorId || !d.title.trim() || !chosen[0]) {
      setPlan(null);
      return;
    }
    let live = true;
    const t = setTimeout(async () => {
      const r = await suggestPlanAction({ vendorId: d.vendorId, title: d.title, date: chosen[0] }).catch(() => null);
      if (live) setPlan(r?.ok && r.value ? JSON.parse(r.value) : null);
    }, 400);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [d.opsPlanRequired, d.vendorId, d.title, chosen]);

  const rateCents = typedRate(d.rate, vendor?.defaultRateCents ?? options.agencyDefaultRateCents);
  const minutes = spanMinutes(d.startTime, d.endTime);
  const differential = (id: string) => options.positionTypes.find((t) => t.id === id)?.rateDifferentialCents ?? 0;
  const summary = detailSummary({
    dates: chosen,
    startTime: d.startTime,
    endTime: d.endTime,
    overrides,
    rateCents,
    positions: d.positions.map((p) => ({ positionTypeId: p.positionTypeId, count: Number(p.count) || 0, differentialCents: differential(p.positionTypeId) })),
    rules: { minimumBillableMinutes: resolveMinimum(null, vendor?.minimumBillableMinutes ?? null, options.minimumBillableMinutes), hourRoundingMinutes: options.hourRoundingMinutes },
  });
  const defaultType = options.defaultPositionTypeId ?? options.positionTypes[0]?.id ?? "";
  const people = d.positions.reduce((n, p) => n + (Number(p.count) || 0), 0);
  const release = chosen[0] ? options.releaseByMonth[chosen[0].slice(0, 7)] : undefined;
  const releaseText = releaseLine(d.held, release);
  const n = chosen.length;

  const submit = (e: React.SubmitEvent) => {
    e.preventDefault();
    setDateErrors({});
    run(
      async () => {
        const r = await createDetailsAction({ detail: { ...d, safetyAddresses: safetyWire(safety) }, dates: chosen, overrides, ...(fromJobId && copyAttachments ? { fromJobId } : {}) });
        const m = r.ok ? null : DATE_ERROR.exec(r.error);
        if (!m) return r;
        // The failing date gets the message beside it, and the status line names it the way the preview does.
        setDateErrors({ [m[1]]: m[2] });
        requestAnimationFrame(() => document.getElementById(`preview-${m[1]}`)?.scrollIntoView({ block: "nearest" }));
        return { ok: false, error: `${keyLabel(m[1])}: ${m[2]} Nothing was created.` };
      },
      (r) => router.push(`/jobs/${r.value}?tab=manage`),
      { refresh: false },
    );
  };
  const clearDateError = (k: string) =>
    setDateErrors((x) => {
      if (!(k in x)) return x;
      const next = { ...x };
      delete next[k];
      return next;
    });

  return (
    <form onSubmit={submit} className="grid gap-4.5 md:grid-cols-[minmax(0,1fr)_340px] md:items-start md:gap-6">
      <div className="flex min-w-0 flex-col gap-4.5">
        {fromTitle ? <Notice tone="info">Copying {fromTitle}. Change anything, then choose the dates.</Notice> : null}
        <Card>
          <CardTitle>Vendor and place</CardTitle>
          <div className="grid gap-3 sm:grid-cols-2">
            <FormField label="Vendor">
              <Select value={d.vendorId} onChange={(e) => setD((x) => ({ ...x, vendorId: e.target.value, locationId: "", contactName: "", contactPhone: "", newContact: null }))} required>
                <option value="">Choose a vendor</option>
                {options.vendors.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.name}
                    {v.paymentHold ? " (on payment hold)" : ""}
                  </option>
                ))}
              </Select>
            </FormField>
            <FormField label="Location" hint={d.vendorId && locations.length === 0 ? "This vendor has no locations yet." : undefined}>
              <Select value={d.locationId} onChange={(e) => set("locationId", e.target.value)} disabled={!d.vendorId}>
                <option value="">No set location</option>
                {locations.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name}
                    {l.address ? `, ${l.address}` : ""}
                  </option>
                ))}
              </Select>
            </FormField>
            <FormField label="Type">
              <Select value={d.typeId} onChange={(e) => set("typeId", e.target.value)} required>
                {options.types.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </Select>
            </FormField>
            <FormField label="Title">
              <Input value={d.title} onChange={(e) => set("title", e.target.value)} required maxLength={200} />
            </FormField>
          </div>
          <FormField label="Description" hint="What deputies read before they sign up.">
            <TextArea value={d.description} onChange={(e) => set("description", e.target.value)} maxLength={4000} />
          </FormField>
          <SiteContactFields
            contacts={contacts}
            vendorChosen={!!d.vendorId}
            value={{ contactName: d.contactName, contactPhone: d.contactPhone, newContact: d.newContact ?? null }}
            onChange={(c) => setD((x) => ({ ...x, ...c }))}
          />
        </Card>

        <Card>
          <CardTitle>When</CardTitle>
          <div className="grid grid-cols-2 gap-3">
            <FormField label="Start time">
              <Input type="time" value={d.startTime} onChange={(e) => set("startTime", e.target.value)} required />
            </FormField>
            <FormField label="End time" hint={minutes !== null && minutes >= 0 && minutesOf(d.endTime)! <= minutesOf(d.startTime)! ? "Ends the next day." : undefined}>
              <Input type="time" value={d.endTime} onChange={(e) => set("endTime", e.target.value)} required />
            </FormField>
          </div>
          <DatesStep
            today={today}
            weekStartsOn={options.weekStartsOn}
            onDates={(list) => {
              setDates(list);
              setRemoved(new Set());
            }}
          />
          {n > 0 ? (
            <div className="flex flex-col gap-1.5">
              <h3 className="m-0 text-body font-semibold">{n === 1 ? "1 detail will be created" : `${n} details will be created`}</h3>
              <ul className="m-0 max-h-96 list-none divide-y divide-divider overflow-y-auto rounded-md border border-line p-0">
                {chosen.map((k) => (
                  <PreviewRow
                    key={k}
                    date={k}
                    start={d.startTime}
                    end={d.endTime}
                    override={overrides[k]}
                    error={dateErrors[k]}
                    onOverride={(o) => {
                      clearDateError(k);
                      setOverrides((x) => {
                        const next = { ...x };
                        if (o) next[k] = o;
                        else delete next[k];
                        return next;
                      });
                    }}
                    onRemove={() => {
                      clearDateError(k);
                      setRemoved((s) => new Set(s).add(k));
                    }}
                  />
                ))}
              </ul>
              <p className="m-0 text-xs text-muted">Change one date&apos;s times or remove it. Every date is saved together, or none are.</p>
            </div>
          ) : null}
          <label className="flex min-h-11 items-center gap-2">
            <input type="checkbox" checked={!!d.flex} onChange={(e) => set("flex", e.target.checked ? { earliest: d.startTime, latest: d.endTime, allowShorter: false } : null)} className="size-4.5 accent-accent" />Flexible times
          </label>
          {d.flex ? <FlexFields flex={d.flex} onFlex={(f) => set("flex", f)} /> : null}
        </Card>

        <Card>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <CardTitle>Positions</CardTitle>
            <span className="text-sm text-muted" data-numeric>
              Total {people} {people === 1 ? "person" : "people"}
            </span>
          </div>
          <ul className="m-0 flex list-none flex-col gap-2.5 p-0">
            {d.positions.map((p, i) => (
              <li key={positionKeys[i]} className="grid grid-cols-[minmax(0,1fr)_5.5rem_auto] items-end gap-2">
                <FormField label={`Position ${i + 1}`}>
                  <Select value={p.positionTypeId} onChange={(e) => set("positions", changePositionType(d.positions, i, e.target.value))}>
                    {options.positionTypes.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.name}
                      </option>
                    ))}
                  </Select>
                </FormField>
                <FormField label="Count">
                  <Input type="number" inputMode="numeric" min={1} max={99} value={p.count} onChange={(e) => set("positions", d.positions.map((x, j) => (j === i ? { ...x, count: Number(e.target.value) } : x)))} />
                </FormField>
                <Button variant="secondary" disabled={d.positions.length === 1} onClick={() => set("positions", d.positions.filter((_, j) => j !== i))} aria-label={`Remove position ${i + 1}`}>
                  Remove
                </Button>
                {differential(p.positionTypeId) ? (
                  <p className="col-span-3 m-0 text-xs text-muted" data-numeric>
                    Pays {dollars(rateCents + differential(p.positionTypeId))}/hr: {dollars(differential(p.positionTypeId))} over the detail&apos;s rate.
                  </p>
                ) : null}
              </li>
            ))}
          </ul>
          <AddPositionRow types={options.positionTypes} defaultTypeId={defaultType} onAdd={(typeId) => set("positions", addPosition(d.positions, typeId))} idPrefix="new" />
          <FormField label="Rate per hour" hint={vendor?.defaultRateCents ? `Blank uses the vendor's ${dollars(vendor.defaultRateCents)}/hr.` : "Blank uses the agency default."}>
            <Input inputMode="decimal" value={d.rate} onChange={(e) => set("rate", e.target.value)} placeholder={vendor?.defaultRateCents ? String(vendor.defaultRateCents / 100) : undefined} className="max-w-40" />
          </FormField>
          <RateRangeNotice rateCents={rateCents} range={options.rateRange} reason={d.rateOverrideReason ?? ""} onReason={(v) => set("rateOverrideReason", v)} canApprove={chosen.length <= 1 && !fromJobId} />
        </Card>

        <Card>
          <CardTitle>Officer safety (optional)</CardTitle>
          <FormField label="Safety notes" hint="Shown above everything else on the detail. People on it are alerted when it changes.">
            <TextArea value={d.safetyNotes} onChange={(e) => set("safetyNotes", e.target.value)} maxLength={4000} />
          </FormField>
          <SafetyAddressFields addresses={safety} onAddresses={setSafety} />
        </Card>

        <Card>
          <CardTitle>Ops plan and release</CardTitle>
          <label className="flex min-h-11 items-center gap-2">
            <input type="checkbox" checked={d.opsPlanRequired} onChange={(e) => set("opsPlanRequired", e.target.checked)} className="size-4.5 accent-accent" />Ops plan required (the Incident Commander submits it before the start)
          </label>
          {plan ? (
            <Notice tone="info">
              Last time: {plan.title} ({plan.year}) has an agreed plan.{" "}
              <a href={`/api/v1/ops-plans/versions/${plan.versionId}/file`} download>
                Download {plan.filename}
              </a>{" "}
              to start from it.
            </Notice>
          ) : null}
          <label className="flex min-h-11 items-center gap-2">
            <input type="checkbox" checked={d.held} onChange={(e) => set("held", e.target.checked)} className="size-4.5 accent-accent" />Hold: do not release until I release it
          </label>
          {fromJobId ? (
            <label className="flex min-h-11 items-center gap-2">
              <input type="checkbox" checked={copyAttachments} onChange={(e) => setCopyAttachments(e.target.checked)} className="size-4.5 accent-accent" />Copy attachments, contract included
            </label>
          ) : null}
          <FormField label="Notes for deputies" hint="Optional">
            <TextArea value={d.notes} onChange={(e) => set("notes", e.target.value)} maxLength={4000} />
          </FormField>
        </Card>
      </div>

      <SummaryCard releaseText={releaseText} summary={summary} n={n} overrides={overrides} chosen={chosen} busy={busy} />
    </form>
  );
}
