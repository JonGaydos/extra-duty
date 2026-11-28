"use client";

import Link from "next/link";
import { useState } from "react";
import { Button, ButtonLink } from "@/ui/components/Button";
import { Card } from "@/ui/components/Card";
import { Chip } from "@/ui/components/Chip";
import { Disclosure } from "@/ui/components/Disclosure";
import { EmptyState } from "@/ui/components/EmptyState";
import { Notice } from "@/ui/components/Notice";
import { Icon } from "@/ui/icons";
import { downloadError } from "../../coordinate/reports/download";

export type AuditListRow = {
  id: string;
  when: string;
  who: string;
  system: boolean;
  label: string;
  groupLabel: string;
  subject: string;
  detailNumber: number | null;
  entityType: string;
  entityId: string | null;
  reason: string | null;
  changes: Array<{ field: string; before: string; after: string }>;
};

type Props = {
  rows: AuditListRow[];
  total: number;
  /** The filters as address-bar parameters, sent with an export so "all matching" means the same entries. */
  query: Record<string, string | string[]>;
  newer: string | null;
  older: string | null;
  page: number;
  pageCount: number;
  filtered: boolean;
  /** Over this many entries a print asks first. */
  largePrint: number;
};

type Status = { ok: boolean; text: string } | null;

const n = (x: number) => x.toLocaleString("en-US");

async function save(url: string, body: unknown, filename: string): Promise<Status> {
  let res: Response;
  try {
    res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  } catch {
    return { ok: false, text: "The download did not work. Check your connection and try again." };
  }
  if (!res.ok) return { ok: false, text: await downloadError(res) };
  const name = /filename="([^"]+)"/.exec(res.headers.get("content-disposition") ?? "")?.[1] ?? filename;
  const href = URL.createObjectURL(await res.blob());
  const a = document.createElement("a");
  a.href = href;
  a.download = name;
  a.click();
  URL.revokeObjectURL(href);
  return { ok: true, text: `Downloaded ${name}.` };
}

/** One entry: when, who, what, about whom, the reason and the readable changes, with a checkbox and its own view. */
function Entry({ r, checked, onCheck }: Readonly<{ r: AuditListRow; checked: boolean; onCheck: (on: boolean) => void }>) {
  return (
    <li className="flex gap-3 px-4 py-3.5" data-testid="audit-entry">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onCheck(e.target.checked)}
        aria-label={`Select ${r.label}, ${r.when}`}
        className="mt-0.5 size-4.5 shrink-0 accent-accent pointer-coarse:size-6"
      />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
          <Link href={`/admin/audit/entries/${r.id}`} className="font-semibold">
            {r.label}
          </Link>
          <span className="text-sm text-muted" data-numeric>
            {r.when}
          </span>
        </div>
        <p className="m-0 text-sm">
          {r.system ? <Chip>System</Chip> : <span>{r.who}</span>}
          <span className="text-muted"> about </span>
          {r.detailNumber === null ? r.subject : <Link href={`/jobs/${r.detailNumber}`}>{r.subject}</Link>}
        </p>
        {r.reason ? <p className="m-0 text-sm text-muted">Reason: {r.reason}</p> : null}
        {r.changes.length ? (
          <Disclosure label={r.changes.length === 1 ? "Show the change" : `Show ${r.changes.length} changes`} openLabel="Hide the changes">
            <dl className="m-0 mt-1 grid gap-x-3 gap-y-1 text-sm sm:grid-cols-[minmax(0,12rem)_minmax(0,1fr)]">
              {r.changes.map((c) => (
                <div key={c.field} className="contents">
                  <dt className="font-medium">{c.field}</dt>
                  <dd className="m-0 break-words text-muted">
                    {c.before} <span className="text-ink">to</span> {c.after}
                  </dd>
                </div>
              ))}
            </dl>
          </Disclosure>
        ) : null}
      </div>
    </li>
  );
}

/** Previous and next page, with where this page is. */
function Pager({ newer, older, page, pageCount }: Readonly<{ newer: string | null; older: string | null; page: number; pageCount: number }>) {
  if (!newer && !older) return null;
  return (
    <nav aria-label="Pages" className="flex items-center justify-between gap-2">
      {newer ? (
        <ButtonLink href={newer} variant="secondary">
          Previous page
        </ButtonLink>
      ) : (
        <span />
      )}
      <span className="text-sm text-muted" data-numeric>
        Page {page} of {pageCount}
      </span>
      {older ? (
        <ButtonLink href={older} variant="secondary">
          Next page
        </ButtonLink>
      ) : (
        <span />
      )}
    </nav>
  );
}

/** The result of the last export or print. */
function StatusLine({ status }: Readonly<{ status: Status }>) {
  return (
    <output aria-live="polite" className="block empty:hidden">
      {status ? (
        <Notice tone={status.ok ? "success" : "danger"} as="div">
          {status.text}
        </Notice>
      ) : null}
    </output>
  );
}

/**
 * The matching entries with checkboxes. "Select all N matching" covers every entry the filters match, not only this
 * page. Export CSV and Print PDF work on the selection; a print of more than `largePrint` entries asks first.
 */
export function AuditResults(p: Readonly<Props>) {
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [all, setAll] = useState(false);
  const [busy, setBusy] = useState<"csv" | "pdf" | null>(null);
  const [status, setStatus] = useState<Status>(null);
  const [confirming, setConfirming] = useState(false);
  const count = all ? p.total : picked.size;
  const pageIds = p.rows.map((r) => r.id);
  const pageAll = pageIds.length > 0 && pageIds.every((id) => picked.has(id));
  const emptyLine = p.filtered ? "Change or reset the filters." : "Changes show here as they happen.";

  const selection = () => (all ? { query: p.query } : { query: p.query, ids: [...picked] });
  const run = async (kind: "csv" | "pdf", confirmLarge = false) => {
    setBusy(kind);
    setStatus(null);
    setConfirming(false);
    const call = kind === "csv" ? save("/api/v1/audit/export", selection(), "audit-log.csv") : save("/api/v1/audit/print", { ...selection(), confirmLarge }, "audit-record.pdf");
    const r = await call;
    setBusy(null);
    setStatus(r);
  };
  const print = () => (count > p.largePrint ? setConfirming(true) : run("pdf"));
  const toggle = (id: string, on: boolean) => {
    // Leaving "all matching" keeps this page's entries picked, less the one cleared.
    const from = all ? new Set(pageIds) : picked;
    setAll(false);
    setPicked(() => {
      const next = new Set(from);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  };

  return (
    <section aria-label="Entries" className="flex min-w-0 flex-col gap-3">
      <div className="flex flex-col gap-2.5 rounded-xl border border-line bg-surface p-3 md:flex-row md:items-center md:justify-between md:rounded-2xl md:px-4">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <label className="flex min-h-11 items-center gap-2 text-sm font-medium">
            <input
              type="checkbox"
              checked={all || pageAll}
              disabled={pageIds.length === 0}
              onChange={(e) => {
                setAll(false);
                setPicked(e.target.checked ? new Set([...picked, ...pageIds]) : new Set([...picked].filter((id) => !pageIds.includes(id))));
              }}
              className="size-4.5 shrink-0 accent-accent"
            />
            <span>Select this page</span>
          </label>
          {p.total > 0 ? (
            <button type="button" onClick={() => setAll(!all)} className="min-h-11 text-sm font-semibold text-link underline decoration-current/50 underline-offset-3" aria-pressed={all}>
              {all ? "Clear the selection" : `Select all ${n(p.total)} matching`}
            </button>
          ) : null}
          <output aria-live="polite" className="text-sm text-muted" data-testid="audit-selected">
            {all ? `All ${n(p.total)} matching entries selected.` : `${n(picked.size)} selected.`}
          </output>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" size="sm" disabled={count === 0} busy={busy === "csv"} onClick={() => run("csv")}>
            <Icon name="download" size={18} />
            Export CSV
          </Button>
          <Button size="sm" disabled={count === 0} busy={busy === "pdf"} onClick={print}>
            <Icon name="file" size={18} />
            Print PDF
          </Button>
        </div>
      </div>

      {confirming ? (
        <Card tone="warning" as="div" data-testid="audit-large">
          <p className="m-0 text-sm text-warning-ink">
            This record would have {n(count)} entries, about {n(Math.ceil(count / 6))} pages. Narrow the filters to print fewer, or print all of them.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" onClick={() => run("pdf", true)}>
              Print all {n(count)}
            </Button>
            <Button size="sm" variant="secondary" onClick={() => setConfirming(false)}>
              Narrow the filters
            </Button>
          </div>
        </Card>
      ) : null}
      <StatusLine status={status} />

      <Card pad={false}>
        {p.rows.length === 0 ? (
          <EmptyState title={p.filtered ? "No matching entries" : "No entries yet"}>{emptyLine}</EmptyState>
        ) : (
          <ul className="m-0 list-none divide-y divide-divider p-0">
            {p.rows.map((r) => (
              <Entry key={r.id} r={r} checked={all || picked.has(r.id)} onCheck={(on) => toggle(r.id, on)} />
            ))}
          </ul>
        )}
      </Card>

      <Pager newer={p.newer} older={p.older} page={p.page} pageCount={p.pageCount} />
    </section>
  );
}
