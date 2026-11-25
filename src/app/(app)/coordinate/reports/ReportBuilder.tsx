"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button, ButtonLink } from "@/ui/components/Button";
import { Card, CardTitle } from "@/ui/components/Card";
import { FormField, Input, Select } from "@/ui/components/FormField";
import { dollars } from "@/ui/components/PayLabel";
import { Table } from "@/ui/components/Table";
import { Icon } from "@/ui/icons";
import { deleteReportAction, runReportAction, saveReportAction, type ReportWire } from "../_coordinator/actions";
import { useCoordAction } from "../_coordinator/status";
import { downloadReport } from "./download";
import { savedDayRange } from "./saved-range";

export type DatasetInfo = { name: string; title: string; groupings: string[]; measures: string[]; filters: string[] };
export type SavedInfo = { id: string; name: string; builtIn: boolean; spec: { dataset: string; groupBy: string[]; measures: string[]; filters: Record<string, string[] | undefined>; from?: string; to?: string } };
type Result = { columns: string[]; rows: Array<Array<string | number | null>>; totals: Record<string, number> };

const isMoney = (c: string) => c.endsWith("_cents");
const fmt = (c: string, v: unknown) => (v === null || v === undefined ? "" : isMoney(c) && typeof v === "number" ? dollars(v) : typeof v === "number" ? v.toLocaleString("en-US") : String(v));

/** A toggle chip: a real button with aria-pressed. */
function Toggle({ on, onClick, children }: { on: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={onClick}
      className={`h-9 rounded-full border px-3.5 text-sm pointer-coarse:h-11 ${on ? "border-ink bg-ink font-semibold text-surface" : "border-line bg-surface text-ink hover:bg-subtle"}`}
    >
      {children}
    </button>
  );
}

/**
 * Built-in and saved reports, and a builder for any report: data, period, filters, grouping and measures. Runs
 * show a table with totals; CSV and PDF download the same spec.
 */
export function ReportBuilder({
  datasets,
  saved,
  labels,
  deputies,
  vendors,
  defaultFrom,
  defaultTo,
}: {
  datasets: DatasetInfo[];
  saved: SavedInfo[];
  labels: Record<string, string>;
  deputies: Array<{ id: string; name: string }>;
  vendors: Array<{ id: string; name: string }>;
  defaultFrom: string;
  defaultTo: string;
}) {
  const router = useRouter();
  const [spec, setSpec] = useState<ReportWire>({ dataset: "invoices" as ReportWire["dataset"], from: defaultFrom, to: defaultTo, filters: {}, groupBy: ["month"] as ReportWire["groupBy"], measures: ["billed_count", "billed_cents"] as ReportWire["measures"] });
  const [title, setTitle] = useState("New report");
  const [result, setResult] = useState<Result | null>(null);
  const [saveName, setSaveName] = useState("");
  const [deputy, setDeputy] = useState("");
  const [downloading, setDownloading] = useState(false);
  const { run, busy } = useCoordAction();
  const ds = datasets.find((d) => d.name === spec.dataset) ?? datasets[0];
  const label = (c: string) => labels[c] ?? c;

  const load = (r: SavedInfo) => {
    if (r.spec.dataset === "activity") {
      router.push(r.builtIn ? "/coordinate/reports/activity" : `/coordinate/reports/activity?saved=${r.id}`);
      return;
    }
    // On phones the builder sits above the list: bring it into view with focus on its heading.
    requestAnimationFrame(() => {
      const h = document.getElementById("report-title");
      h?.focus();
      h?.scrollIntoView({ block: "start" });
    });
    setTitle(r.name);
    setResult(null);
    setSpec({
      dataset: r.spec.dataset as ReportWire["dataset"],
      groupBy: r.spec.groupBy as ReportWire["groupBy"],
      measures: r.spec.measures as ReportWire["measures"],
      filters: Object.fromEntries(Object.entries(r.spec.filters).filter(([, v]) => v && v.length)) as ReportWire["filters"],
      from: savedDayRange(r.spec)?.from ?? spec.from,
      to: savedDayRange(r.spec)?.to ?? spec.to,
    });
  };
  const toggle = <K extends "groupBy" | "measures">(k: K, v: string) =>
    setSpec((s) => ({ ...s, [k]: (s[k] as string[]).includes(v) ? (s[k] as string[]).filter((x) => x !== v) : [...(s[k] as string[]), v] }));
  const setFilter = (k: "userIds" | "vendorIds", v: string) => setSpec((s) => ({ ...s, filters: { ...s.filters, [k]: v ? [v] : undefined } }));

  // A refused export (too many records, no access) says why on the status line.
  const exportAs = (format: "csv" | "pdf") =>
    run(
      async () => {
        setDownloading(true);
        try {
          return await downloadReport(spec, format, `${title.replace(/[^\w\- ]+/g, "").trim() || "report"}.${format}`);
        } finally {
          setDownloading(false);
        }
      },
      undefined,
      { refresh: false, quiet: true },
    );

  const builtIn = saved.filter((r) => r.builtIn);
  const mine = saved.filter((r) => !r.builtIn);
  const list = (rows: SavedInfo[]) => (
    <ul className="m-0 flex list-none flex-col p-0">
      {rows.map((r) => (
        <li key={r.id} className="flex items-center justify-between gap-1">
          <button type="button" onClick={() => load(r)} aria-current={title === r.name ? "true" : undefined} className="min-h-10 flex-1 rounded-sm px-2.5 py-1.5 text-left text-body hover:bg-subtle aria-[current=true]:bg-accent-soft aria-[current=true]:font-semibold aria-[current=true]:text-link pointer-coarse:min-h-11">
            {r.name}
          </button>
          {!r.builtIn ? (
            <button type="button" onClick={() => run(() => deleteReportAction(r.id))} className="flex size-10 items-center justify-center rounded-sm text-muted hover:bg-subtle hover:text-ink" aria-label={`Delete ${r.name}`}>
              <Icon name="cross" size={16} />
            </button>
          ) : null}
        </li>
      ))}
    </ul>
  );

  return (
    <div className="grid gap-4.5 md:grid-cols-[260px_minmax(0,1fr)] md:items-start md:gap-6">
      <div className="order-2 flex flex-col gap-4.5 md:order-1">
        <Card>
          <h2 className="m-0 text-xs font-semibold text-muted">Built in</h2>
          {list(builtIn)}
          <h2 className="m-0 text-xs font-semibold text-muted">Saved</h2>
          {mine.length ? list(mine) : <p className="m-0 text-sm text-muted">Reports you save show up here.</p>}
        </Card>
        <Card>
          <CardTitle>Personnel activity</CardTitle>
          <p className="m-0 text-sm text-muted">Details worked, sign-ups and cancellations for each person, with the top five on each.</p>
          <ButtonLink href="/coordinate/reports/activity" variant="secondary" size="sm" className="w-fit">
            Open personnel activity
          </ButtonLink>
        </Card>
        <Card>
          <CardTitle>A deputy&apos;s earnings</CardTitle>
          <form
            className="flex flex-col gap-2.5"
            onSubmit={(e) => {
              e.preventDefault();
              if (deputy) router.push(`/coordinate/reports/deputies/${deputy}`);
            }}
          >
            <FormField label="Deputy">
              <Select value={deputy} onChange={(e) => setDeputy(e.target.value)} required>
                <option value="">Choose a deputy</option>
                {deputies.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                  </option>
                ))}
              </Select>
            </FormField>
            <Button type="submit" variant="secondary" size="sm" className="w-fit">
              Open earnings and tax summary
            </Button>
          </form>
        </Card>
      </div>

      <div className="order-1 flex min-w-0 flex-col gap-4.5 md:order-2">
        <Card>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 id="report-title" tabIndex={-1} className="m-0 scroll-mt-4 text-title font-semibold outline-none md:text-base">
              {title}
            </h2>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="secondary" busy={downloading} onClick={() => exportAs("csv")}>
                <Icon name="download" size={16} />
                CSV
              </Button>
              <Button size="sm" variant="secondary" busy={downloading} onClick={() => exportAs("pdf")}>
                <Icon name="download" size={16} />
                PDF
              </Button>
            </div>
          </div>
          <form
            className="flex flex-col gap-3.5"
            onSubmit={(e) => {
              e.preventDefault();
              run(() => runReportAction(spec), (r) => setResult(JSON.parse(r.value ?? "null")), { refresh: false, quiet: true });
            }}
          >
            <div className="grid gap-3 sm:grid-cols-3">
              <FormField label="Data">
                <Select
                  value={spec.dataset}
                  onChange={(e) => {
                    const d = datasets.find((x) => x.name === e.target.value)!;
                    setResult(null);
                    setSpec((s) => ({ ...s, dataset: d.name as ReportWire["dataset"], groupBy: s.groupBy.filter((g) => d.groupings.includes(g)), measures: (s.measures.filter((m) => d.measures.includes(m)).length ? s.measures.filter((m) => d.measures.includes(m)) : [d.measures[0]]) as ReportWire["measures"], filters: {} }));
                  }}
                >
                  {datasets.map((d) => (
                    <option key={d.name} value={d.name}>
                      {d.title}
                    </option>
                  ))}
                </Select>
              </FormField>
              <FormField label="From">
                <Input type="date" value={spec.from} onChange={(e) => setSpec({ ...spec, from: e.target.value })} required />
              </FormField>
              <FormField label="To">
                <Input type="date" value={spec.to} onChange={(e) => setSpec({ ...spec, to: e.target.value })} required />
              </FormField>
              {ds.filters.includes("userIds") ? (
                <FormField label="Deputies">
                  <Select value={spec.filters.userIds?.[0] ?? ""} onChange={(e) => setFilter("userIds", e.target.value)}>
                    <option value="">All deputies</option>
                    {deputies.map((d) => (
                      <option key={d.id} value={d.id}>
                        {d.name}
                      </option>
                    ))}
                  </Select>
                </FormField>
              ) : null}
              {ds.filters.includes("vendorIds") ? (
                <FormField label="Vendors">
                  <Select value={spec.filters.vendorIds?.[0] ?? ""} onChange={(e) => setFilter("vendorIds", e.target.value)}>
                    <option value="">All vendors</option>
                    {vendors.map((d) => (
                      <option key={d.id} value={d.id}>
                        {d.name}
                      </option>
                    ))}
                  </Select>
                </FormField>
              ) : null}
            </div>
            <div role="group" aria-label="Group by" className="flex flex-col gap-1.5">
              <span className="text-sm font-medium text-muted" aria-hidden>
                Group by
              </span>
              <div className="flex flex-wrap gap-1.5">
                {ds.groupings.map((g) => (
                  <Toggle key={g} on={spec.groupBy.includes(g as never)} onClick={() => toggle("groupBy", g)}>
                    {label(g)}
                  </Toggle>
                ))}
              </div>
            </div>
            <div role="group" aria-label="Show" className="flex flex-col gap-1.5">
              <span className="text-sm font-medium text-muted" aria-hidden>
                Show
              </span>
              <div className="flex flex-wrap gap-1.5">
                {ds.measures.map((m) => (
                  <Toggle key={m} on={spec.measures.includes(m as never)} onClick={() => toggle("measures", m)}>
                    {label(m)}
                  </Toggle>
                ))}
              </div>
            </div>
            <div className="flex flex-wrap items-end gap-2">
              <Button type="submit" busy={busy}>
                Run report
              </Button>
              <div className="flex flex-wrap items-end gap-2">
                <FormField label="Save as">
                  <Input value={saveName} onChange={(e) => setSaveName(e.target.value)} maxLength={120} className="max-w-56" />
                </FormField>
                <Button variant="secondary" disabled={!saveName.trim()} onClick={() => run(() => saveReportAction({ name: saveName, spec }), () => setTitle(saveName))}>
                  Save
                </Button>
              </div>
            </div>
          </form>
        </Card>

        {result ? (
          <Table
            caption={`${title}, ${spec.from} to ${spec.to}`}
            rows={[
              ...result.rows.map((r, i) => ({ key: String(i), cells: r, total: false })),
              ...(spec.groupBy.length && result.rows.length ? [{ key: "total", cells: result.columns.map((c, i) => (i === 0 ? "Total" : c in result.totals ? result.totals[c] : null)), total: true }] : []),
            ]}
            rowKey={(r) => r.key}
            columns={result.columns.map((c, i) => ({
              header: label(c),
              align: i >= spec.groupBy.length ? ("end" as const) : ("start" as const),
              cell: (r: { cells: Array<string | number | null>; total: boolean }) => <span className={r.total ? "font-semibold" : undefined}>{fmt(c, r.cells[i])}</span>,
            }))}
            empty="No rows for this period."
          />
        ) : (
          <Card>
            <p className="m-0 text-sm text-muted">Choose a report or build one, then Run report. Dates and months are grouped in Central time.</p>
          </Card>
        )}
      </div>
    </div>
  );
}
