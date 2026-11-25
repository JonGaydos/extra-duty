import type { Metadata } from "next";
import Link from "next/link";
import { Disclosure } from "@/ui/components/Disclosure";
import { withTx } from "@/ui/shell/request";
import { auditView } from "@/domain/admin/views";
import { agencyDateOnly } from "@/domain/time/agency-time";
import { Button, ButtonLink } from "@/ui/components/Button";
import { Card } from "@/ui/components/Card";
import { FormField, Input, Select } from "@/ui/components/FormField";
import { Table } from "@/ui/components/Table";
import { PageTitle } from "../../_personnel/TabLinks";
import { dateTime } from "../../_personnel/format";
import { managementActor } from "../_admin/session";
import { auditLabel } from "../_admin/audit-labels";

export const metadata: Metadata = { title: "Audit log" };

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

const str = (v: string | string[] | undefined) => (typeof v === "string" ? v.trim() : "");

/** Before and after values, compact, for the expandable cell. */
function changes(before: unknown, after: unknown): string {
  const show = (v: unknown) => (v === null || v === undefined ? "none" : JSON.stringify(v, null, 2));
  return `Before: ${show(before)}\n\nAfter: ${show(after)}`;
}

/** Every recorded change, newest first, filtered by record type, record id and dates (agency days). */
export default async function AuditPage({ searchParams }: Props) {
  const actor = await managementActor();
  const sp = await searchParams;
  const type = str(sp.type);
  const id = str(sp.id);
  const from = str(sp.from);
  const to = str(sp.to);
  const page = Math.max(1, Number(str(sp.page)) || 1);
  const view = await withTx((tx) =>
    auditView(actor, tx, { entityType: type || undefined, entityId: id || undefined, from: agencyDateOnly(from, "start") ?? undefined, to: agencyDateOnly(to, "end") ?? undefined }, page),
  );
  const query = (p: number) => {
    const q = new URLSearchParams();
    if (type) q.set("type", type);
    if (id) q.set("id", id);
    if (from) q.set("from", from);
    if (to) q.set("to", to);
    if (p > 1) q.set("page", String(p));
    const s = q.toString();
    return `/admin/audit${s ? `?${s}` : ""}`;
  };
  const filtered = !!(type || id || from || to);

  return (
    <div className="flex flex-col gap-4.5">
      <PageTitle sub="Who changed what, and when. Entries cannot be edited or removed.">Audit log</PageTitle>
      <Card>
        <form role="search" aria-label="Filter the audit log" action="/admin/audit" className="grid gap-3 md:grid-cols-[repeat(4,minmax(0,1fr))_auto] md:items-end">
          <FormField label="Record type">
            <Select name="type" defaultValue={type}>
              <option value="">All types</option>
              {view.types.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </Select>
          </FormField>
          <FormField label="Record id">
            <Input name="id" defaultValue={id} autoComplete="off" />
          </FormField>
          <FormField label="From">
            <Input type="date" name="from" defaultValue={from} />
          </FormField>
          <FormField label="To">
            <Input type="date" name="to" defaultValue={to} />
          </FormField>
          <div className="flex gap-2">
            <Button type="submit">Filter</Button>
            {filtered ? (
              <ButtonLink href="/admin/audit" variant="secondary">
                Clear
              </ButtonLink>
            ) : null}
          </div>
        </form>
      </Card>
      <Table
        caption={`Changes${page > 1 ? `, page ${page}` : ""}`}
        hideCaption
        rows={view.rows}
        rowKey={(r) => r.id}
        empty={filtered ? "No changes match these filters." : "No changes recorded yet."}
        columns={[
          { header: "When", cell: (r) => <span className="whitespace-nowrap" data-numeric>{dateTime(r.at)}</span> },
          { header: "Who", cell: (r) => r.actorName ?? (r.actorUserId ? "Unknown" : "System") },
          {
            header: "Action",
            cell: (r) => (
              <span className="flex flex-col">
                <span>{auditLabel(r.action)}</span>
                <code className="text-xs text-muted">{r.action}</code>
              </span>
            ),
          },
          {
            header: "Record",
            cell: (r) => (
              <span className="flex flex-col">
                <span>{r.entityType}</span>
                {r.entityId ? (
                  <Link href={`/admin/audit?type=${encodeURIComponent(r.entityType)}&id=${encodeURIComponent(r.entityId)}`} className="text-xs break-all" aria-label={`History of ${r.entityType} ${r.entityId}`}>
                    {r.entityId}
                  </Link>
                ) : null}
              </span>
            ),
          },
          {
            header: "Change",
            cell: (r) => (
              <Disclosure label={r.reason ? `Reason: ${r.reason}` : "Show the change"} className="max-w-[36rem]">
                <pre className="m-0 mt-2 max-h-80 overflow-auto rounded-sm bg-subtle p-2.5 text-xs whitespace-pre-wrap break-all">{changes(r.before, r.after)}</pre>
              </Disclosure>
            ),
          },
        ]}
      />
      {page > 1 || view.hasMore ? (
        <nav aria-label="Pages" className="flex justify-between gap-2">
          {page > 1 ? (
            <ButtonLink href={query(page - 1)} variant="secondary">
              Newer
            </ButtonLink>
          ) : (
            <span />
          )}
          {view.hasMore ? (
            <ButtonLink href={query(page + 1)} variant="secondary">
              Older
            </ButtonLink>
          ) : null}
        </nav>
      ) : null}
    </div>
  );
}
