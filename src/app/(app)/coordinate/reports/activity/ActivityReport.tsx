"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { Button } from "@/ui/components/Button";
import { Card } from "@/ui/components/Card";
import { FormField, Input, Select } from "@/ui/components/FormField";
import { dollars } from "@/ui/components/PayLabel";
import { ScrollRegion } from "@/ui/components/ScrollRegion";
import { Icon } from "@/ui/icons";
import { runReportAction, saveReportAction, type ReportWire } from "../../_coordinator/actions";
import { useCoordAction } from "../../_coordinator/status";
import { downloadReport } from "../download";
import { savedDayRange } from "../saved-range";
import { activityRows, leaders, rangeText, sortRows, type ActivityResult, type ActivityRow } from "./model";

type Range = { from: string; to: string };
type Preset = "month" | "year" | "season" | "custom";
export type SavedActivity = { name: string; spec: { filters: { rankIds?: string[]; qualificationIds?: string[] }; from?: string; to?: string } };

const BOARDS: Array<{ column: string; title: string }> = [
  { column: "hours", title: "Most hours" },
  { column: "details_worked", title: "Most details" },
  { column: "cancellations", title: "Most cancellations" },
  { column: "late_cancels", title: "Most vendor late cancels" },
  { column: "no_shows", title: "Most no-shows" },
];

function show(column: string, v: number | null | undefined): string {
  if (v === null || v === undefined) return "n/a";
  if (column.endsWith("_cents")) return dollars(v);
  if (column === "cancellation_rate") return `${v.toLocaleString("en-US")}%`;
  return v.toLocaleString("en-US");
}

/** Presets and filters, the five leaderboards, then the sortable table. Runs through the report engine. */
export function ActivityReport({
  measures,
  labels,
  periods,
  ranks,
  flags,
  saved,
}: {
  measures: string[];
  labels: Record<string, string>;
  periods: { month: Range; year: Range; season: (Range & { name: string }) | null };
  ranks: Array<{ id: string; name: string }>;
  flags: Array<{ id: string; name: string }>;
  saved: SavedActivity | null;
}) {
  const savedRange = saved ? savedDayRange(saved.spec) : null;
  const [preset, setPreset] = useState<Preset>(savedRange ? "custom" : "month");
  const [custom, setCustom] = useState<Range>(savedRange ?? periods.month);
  const [rankId, setRankId] = useState(saved?.spec.filters.rankIds?.[0] ?? "");
  const [flagId, setFlagId] = useState(saved?.spec.filters.qualificationIds?.[0] ?? "");
  const [result, setResult] = useState<ActivityResult | null>(null);
  const [ran, setRan] = useState<Range | null>(null);
  const [sort, setSort] = useState<{ column: string; dir: "asc" | "desc" }>({ column: "hours", dir: "desc" });
  const [saveName, setSaveName] = useState("");
  const [downloading, setDownloading] = useState(false);
  const { run, busy } = useCoordAction();

  const range: Range = preset === "custom" ? custom : preset === "season" && periods.season ? periods.season : preset === "year" ? periods.year : periods.month;
  const spec: ReportWire = {
    dataset: "activity",
    from: range.from,
    to: range.to,
    filters: { ...(rankId ? { rankIds: [rankId] } : {}), ...(flagId ? { qualificationIds: [flagId] } : {}) },
    groupBy: ["deputy"],
    measures: measures as ReportWire["measures"],
  };
  const go = () =>
    run(
      () => runReportAction(spec),
      (r) => {
        setResult(JSON.parse(r.value ?? "null"));
        setRan(range);
      },
      { refresh: false, quiet: true },
    );
  // Run once on arrival with the default (or saved) period.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(go, []);

  const rows = useMemo(() => (result ? activityRows(result) : []), [result]);
  const sorted = useMemo(() => sortRows(rows, sort.column, sort.dir), [rows, sort]);
  const columns = ["name", ...measures];
  const head = (c: string) => (c === "name" ? labels.deputy : labels[c]);

  // A refused export (too many records, no access) says why on the status line.
  const exportCsv = () =>
    run(
      async () => {
        setDownloading(true);
        try {
          return await downloadReport(spec, "csv", `Personnel activity ${range.from} to ${range.to}.csv`);
        } finally {
          setDownloading(false);
        }
      },
      undefined,
      { refresh: false, quiet: true },
    );

  const PRESETS: Array<{ key: Preset; label: string; hint?: string }> = [
    { key: "month", label: "This month" },
    { key: "year", label: "This year" },
    ...(periods.season ? [{ key: "season" as const, label: "Season", hint: periods.season.name }] : []),
    { key: "custom", label: "Custom" },
  ];

  return (
    <div className="flex flex-col gap-4.5">
      <Card>
        <form
          className="flex flex-col gap-3.5"
          onSubmit={(e) => {
            e.preventDefault();
            go();
          }}
        >
          <fieldset className="m-0 flex flex-col gap-1.5 border-0 p-0">
            <legend className="mb-1.5 p-0 text-sm font-medium text-muted">Period</legend>
            <div className="flex flex-wrap gap-1 rounded-md border border-line bg-surface p-1 md:w-fit">
              {PRESETS.map((p) => (
                <label
                  key={p.key}
                  className="inline-flex min-h-9 flex-1 cursor-pointer items-center justify-center rounded-sm px-3 text-body font-medium whitespace-nowrap text-muted hover:bg-subtle hover:text-ink has-checked:bg-accent-soft has-checked:font-semibold has-checked:text-link has-focus-visible:outline-2 has-focus-visible:outline-offset-2 has-focus-visible:outline-focus pointer-coarse:min-h-11 md:flex-none"
                >
                  <input type="radio" name="period" value={p.key} checked={preset === p.key} onChange={() => setPreset(p.key)} className="sr-only" />
                  {p.label}
                  {p.hint ? <span className="sr-only">: {p.hint}</span> : null}
                </label>
              ))}
            </div>
            <p className="m-0 text-xs text-muted" data-numeric>
              {preset === "season" && periods.season ? `${periods.season.name}, ` : ""}
              {rangeText(range)}
            </p>
          </fieldset>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {preset === "custom" ? (
              <>
                <FormField label="From">
                  <Input type="date" value={custom.from} onChange={(e) => setCustom({ ...custom, from: e.target.value })} required />
                </FormField>
                <FormField label="To">
                  <Input type="date" value={custom.to} onChange={(e) => setCustom({ ...custom, to: e.target.value })} required />
                </FormField>
              </>
            ) : null}
            <FormField label="Rank">
              <Select value={rankId} onChange={(e) => setRankId(e.target.value)}>
                <option value="">Every rank</option>
                {ranks.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name}
                  </option>
                ))}
              </Select>
            </FormField>
            <FormField label="Flag">
              <Select value={flagId} onChange={(e) => setFlagId(e.target.value)}>
                <option value="">Any flags</option>
                {flags.map((q) => (
                  <option key={q.id} value={q.id}>
                    {q.name}
                  </option>
                ))}
              </Select>
            </FormField>
          </div>
          <div className="flex flex-wrap items-end gap-2">
            <Button type="submit" busy={busy}>
              Run report
            </Button>
            <Button variant="secondary" busy={downloading} onClick={exportCsv}>
              <Icon name="download" size={18} />
              Download CSV
            </Button>
            <div className="flex flex-wrap items-end gap-2 md:ml-auto">
              <FormField label="Save as">
                <Input value={saveName} onChange={(e) => setSaveName(e.target.value)} maxLength={120} className="max-w-56" />
              </FormField>
              <Button variant="secondary" disabled={!saveName.trim()} onClick={() => run(() => saveReportAction({ name: saveName, spec }))}>
                Save
              </Button>
            </div>
          </div>
        </form>
      </Card>

      {result ? (
        <>
          <section aria-labelledby="leaders-title" className="flex flex-col gap-2.5">
            <h2 id="leaders-title" className="m-0 text-title font-semibold md:text-base">
              Top five{ran ? <span className="font-normal text-muted">, {rangeText(ran)}</span> : null}
            </h2>
            <div className="grid gap-2.5 sm:grid-cols-2 xl:grid-cols-5">
              {BOARDS.map((b) => (
                <Leaderboard key={b.column} title={b.title} column={b.column} unit={labels[b.column]} rows={leaders(rows, b.column)} />
              ))}
            </div>
          </section>

          <ScrollRegion label="Personnel activity table" className="overflow-x-auto rounded-xl border border-line bg-surface md:rounded-2xl">
            <table className="w-full border-collapse text-body">
              <caption className="px-4 pt-4 pb-1 text-left text-title font-semibold md:text-base">
                Everyone, {rows.length} {rows.length === 1 ? "person" : "people"}
              </caption>
              <thead>
                <tr>
                  {columns.map((c) => {
                    const on = sort.column === c;
                    return (
                      <th key={c} scope="col" aria-sort={on ? (sort.dir === "asc" ? "ascending" : "descending") : undefined} className={`px-2 py-1.5 align-bottom ${c === "name" ? "text-left" : "text-right"}`}>
                        <button
                          type="button"
                          onClick={() => setSort(on ? { column: c, dir: sort.dir === "asc" ? "desc" : "asc" } : { column: c, dir: c === "name" ? "asc" : "desc" })}
                          className={`inline-flex min-h-9 items-end gap-1 rounded-sm px-1.5 py-1 text-xs font-semibold hover:bg-subtle hover:text-ink pointer-coarse:min-h-11 ${on ? "text-ink" : "text-muted"} ${c === "name" ? "" : "flex-row-reverse text-right"}`}
                        >
                          <span className="max-w-24 text-balance">{head(c)}</span>
                          <Icon name={on && sort.dir === "asc" ? "up" : "down"} size={14} className={on ? "" : "opacity-0"} />
                        </button>
                      </th>
                    );
                  })}
                </tr>
              </thead>
              <tbody>
                {sorted.length === 0 ? (
                  <tr className="border-t border-divider">
                    <td colSpan={columns.length} className="px-3.5 py-6 text-center text-muted">
                      Nobody matches these filters.
                    </td>
                  </tr>
                ) : (
                  sorted.map((r) => (
                    <tr key={r.userId} className="border-t border-divider">
                      <th scope="row" className="px-3.5 py-3 text-left font-normal whitespace-nowrap">
                        <PersonLink row={r} />
                      </th>
                      {measures.map((m) => (
                        <td key={m} className={`px-3.5 py-3 text-right whitespace-nowrap ${r.values[m] === null ? "text-muted" : ""}`} data-numeric>
                          {show(m, r.values[m])}
                        </td>
                      ))}
                    </tr>
                  ))
                )}
              </tbody>
              {sorted.length > 0 ? (
                <tfoot>
                  <tr className="border-t border-line">
                    <th scope="row" className="px-3.5 py-3 text-left font-semibold">
                      Total
                    </th>
                    {measures.map((m) => (
                      <td key={m} className="px-3.5 py-3 text-right font-semibold whitespace-nowrap" data-numeric>
                        {show(m, result.totals[m])}
                      </td>
                    ))}
                  </tr>
                </tfoot>
              ) : null}
            </table>
          </ScrollRegion>
          <p className="m-0 max-w-[70ch] text-xs text-muted">
            Billed and paid details count as worked. Gave away is the person canceling their own sign-up. Vendor late cancels are details the vendor canceled late, paid or not; they are shown for information and never count as a cancellation by the person. A detail the agency canceled, a removal by suspension, and a sign-up removed because the person left the agency, is a sign-up but not a cancellation. The rate is cancellations out of sign-ups.
          </p>
        </>
      ) : (
        <Card>
          <p className="m-0 text-sm text-muted">{busy ? "Running the report." : "Choose a period, then Run report."}</p>
        </Card>
      )}
    </div>
  );
}

function PersonLink({ row }: { row: ActivityRow }) {
  return <Link href={`/coordinate/reports/deputies/${row.userId}`}>{row.name}</Link>;
}

function Leaderboard({ title, column, unit, rows }: { title: string; column: string; unit: string; rows: ActivityRow[] }) {
  const id = `board-${column}`;
  return (
    <Card aria-labelledby={id} className="gap-2!">
      <h3 id={id} className="m-0 text-sm font-semibold">
        {title}
      </h3>
      {rows.length === 0 ? (
        <p className="m-0 text-sm text-muted">Nobody in this period.</p>
      ) : (
        <ol className="m-0 flex list-none flex-col p-0">
          {rows.map((r, i) => (
            <li key={r.userId} className="flex items-baseline gap-2 border-t border-divider py-1.5 first:border-t-0">
              <span className="w-4 shrink-0 text-xs font-semibold text-muted" data-numeric aria-hidden>
                {i + 1}
              </span>
              <span className="min-w-0 flex-1 truncate">
                <PersonLink row={r} />
              </span>
              <span className="shrink-0 font-semibold" data-numeric>
                {show(column, r.values[column])}
                <span className="sr-only"> {unit.toLowerCase()}</span>
              </span>
            </li>
          ))}
        </ol>
      )}
    </Card>
  );
}
