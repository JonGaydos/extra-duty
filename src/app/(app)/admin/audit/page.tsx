import type { Metadata } from "next";
import { asc } from "drizzle-orm";
import { withTx } from "@/ui/shell/request";
import { users, vendors } from "@/db/schema";
import { LARGE_PRINT, whoText } from "@/domain/audit/records";
import { auditQueryParams, parseAuditQuery, searchAudit, type AuditQuery } from "@/domain/audit/search";
import { ActionLink } from "@/ui/components/Button";
import { PageTitle } from "../../_personnel/TabLinks";
import { dateTime } from "../../_personnel/format";
import { managementActor } from "../_admin/session";
import { AuditFilters } from "./AuditFilters";
import { AuditResults, type AuditListRow } from "./AuditResults";

export const metadata: Metadata = { title: "Audit log" };

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

/** How many filters are on, for the phone's Filters button. */
function activeFilters(q: AuditQuery): number {
  return [q.doneBy, q.about, q.groups?.length, q.detail, q.vendorId, q.invoice, q.preset, q.text, q.system === false, q.order === "oldest", q.entityType].filter(Boolean).length;
}

const asRecord = (p: URLSearchParams) => {
  const out: Record<string, string | string[]> = {};
  for (const k of new Set(p.keys())) {
    const all = p.getAll(k);
    out[k] = all.length > 1 ? all : all[0];
  }
  return out;
};

/**
 * Every recorded action, filtered by who did it, who it is about, action type, detail, vendor, invoice, dates and text,
 * paged newest (or oldest) first. Entries can be selected, or all matching ones, and exported as CSV or printed as a
 * formal Audit Record PDF.
 */
export default async function AuditPage({ searchParams }: Readonly<Props>) {
  const actor = await managementActor();
  const sp = await searchParams;
  const q = parseAuditQuery(sp);
  const page = Math.max(1, Number(typeof sp.page === "string" ? sp.page : "") || 1);
  const { result, people, vendorList } = await withTx(async (tx) => ({
    result: await searchAudit(actor, tx, q, page),
    people: await tx.select({ id: users.id, name: users.name }).from(users).orderBy(asc(users.name)),
    vendorList: await tx.select({ id: vendors.id, name: vendors.name }).from(vendors).orderBy(asc(vendors.name)),
  }));
  const params = auditQueryParams(q);
  const href = (p: number) => {
    const x = new URLSearchParams(params);
    if (p > 1) x.set("page", String(p));
    const s = x.toString();
    return s ? `/admin/audit?${s}` : "/admin/audit";
  };
  const rows: AuditListRow[] = result.rows.map((r) => ({
    id: r.id,
    when: dateTime(r.at),
    who: whoText(r),
    system: r.system,
    label: r.label,
    groupLabel: r.groupLabel,
    subject: r.subject,
    detailNumber: r.detailNumber,
    entityType: r.entityType,
    entityId: r.entityId,
    reason: r.reason,
    changes: r.changes,
  }));
  const filtered = activeFilters(q) > 0;
  const n = result.total.toLocaleString("en-US");
  const noun = result.total === 1 ? "entry" : "entries";
  const totalLine = filtered ? `${n} matching ${noun}.` : `${n} ${noun}.`;

  return (
    <div className="flex flex-col gap-4.5">
      <PageTitle
        sub="Who did what, and when. Entries cannot be edited or removed."
        action={actor.role === "admin" ? <ActionLink href="/admin/audit/verify">Verify a printed record</ActionLink> : undefined}
      >
        Audit log
      </PageTitle>
      <p className="m-0 text-sm text-muted" data-testid="audit-total">
        {totalLine}
      </p>
      <div className="grid gap-4.5 md:grid-cols-[272px_minmax(0,1fr)] md:items-start">
        <AuditFilters q={q} people={people} vendors={vendorList} active={activeFilters(q)} />
        <AuditResults
          rows={rows}
          total={result.total}
          query={asRecord(params)}
          newer={result.page > 1 ? href(result.page - 1) : null}
          older={result.page < result.pageCount ? href(result.page + 1) : null}
          page={result.page}
          pageCount={result.pageCount}
          filtered={filtered}
          largePrint={LARGE_PRINT}
        />
      </div>
    </div>
  );
}
