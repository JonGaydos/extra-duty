import type { Metadata } from "next";
import { asc, eq, ne, and } from "drizzle-orm";
import { withTx } from "@/ui/shell/request";
import { users } from "@/db/schema";
import { listQualifications } from "@/domain/jobs/qualifications";
import { listRanks } from "@/domain/ranks/ranks";
import { agencyDayKey } from "@/domain/time/agency-time";
import { listW9Requests, w9RequestDetail, type RequestPersonStatus } from "@/domain/w9/requests";
import { dayText, pendingW9Reviews } from "@/domain/w9/w9";
import { Card } from "@/ui/components/Card";
import { Chip, type ChipTone } from "@/ui/components/Chip";
import { Disclosure } from "@/ui/components/Disclosure";
import { EmptyState } from "@/ui/components/EmptyState";
import { ButtonLink } from "@/ui/components/Button";
import Link from "next/link";
import { PageTitle } from "../../_personnel/TabLinks";
import { dateLabel, dateTime, plural } from "../../_personnel/format";
import { CountSection, Row, Rows } from "../../coordinate/_coordinator/ui";
import { managementActor } from "../_admin/session";
import { RequestForm } from "./RequestForm";
import { uploadedBy } from "../../_shared/w9";

export const metadata: Metadata = { title: "W-9s" };

const STATUS: Record<RequestPersonStatus, { label: string; tone: ChipTone }> = {
  done: { label: "Done", tone: "success" },
  pending: { label: "Pending review", tone: "warning" },
  rejected: { label: "Rejected", tone: "danger" },
  missing: { label: "Missing", tone: "neutral" },
};
const ORDER: RequestPersonStatus[] = ["missing", "rejected", "pending", "done"];

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

/** W-9s waiting for review, asking people for a new W-9, and every request with who is done, pending, rejected or missing. */
export default async function W9Page({ searchParams }: Readonly<Props>) {
  const actor = await managementActor();
  const sp = await searchParams;
  const person = typeof sp.person === "string" ? sp.person : "";
  const now = new Date();
  const data = await withTx(async (tx) => {
    const requests = await listW9Requests(actor, tx, now);
    const people = new Map<string, Awaited<ReturnType<typeof w9RequestDetail>>["people"]>();
    // Sequential: one short read per request in this transaction.
    for (const r of requests) people.set(r.id, (await w9RequestDetail(actor, tx, r.id)).people);
    return {
      pending: await pendingW9Reviews(tx),
      requests,
      people,
      ranks: (await listRanks(tx)).filter((r) => r.active).map((r) => ({ id: r.id, name: r.name })),
      flags: (await listQualifications(actor, tx)).filter((f) => f.active).map((f) => ({ id: f.id, name: f.name })),
      directory: await tx.select({ id: users.id, name: users.name }).from(users).where(and(eq(users.active, true), ne(users.role, "vendor"))).orderBy(asc(users.name)),
    };
  });
  const tomorrow = agencyDayKey(new Date(now.getTime() + 86_400_000));

  return (
    <div className="flex flex-col gap-4.5">
      <p className="m-0 text-sm">
        <Link href="/admin">Management</Link>
      </p>
      <PageTitle sub="Every W-9 is stored encrypted, and every view, approval and rejection is kept in the audit log.">W-9s</PageTitle>

      <CountSection title="W-9 to review" count={data.pending.length}>
        {data.pending.length ? (
          <Rows>
            {data.pending.map((w) => (
              <Row
                key={w.w9Id}
                title={w.name}
                href={`/admin/users/${w.userId}#w9`}
                meta={`Uploaded ${dateTime(w.uploadedAt)}${uploadedBy(w.uploadedByName)}`}
                actions={
                  <ButtonLink href={`/admin/users/${w.userId}#w9`} size="sm" variant="secondary" aria-label={`Review W-9, ${w.name}`}>
                    Review
                  </ButtonLink>
                }
              />
            ))}
          </Rows>
        ) : (
          <Card pad={false}>
            <EmptyState title="Nothing to review">New W-9s show up here and on To-do.</EmptyState>
          </Card>
        )}
      </CountSection>

      <CountSection title="Ask for a new W-9">
        <Card>
          <p className="m-0 max-w-[70ch] text-sm text-muted">
            Each person asked gets an alert with the due date, then reminders a week before and the day before. Their current W-9 keeps counting until the due date.
          </p>
          <RequestForm ranks={data.ranks} flags={data.flags} people={data.directory} tomorrow={tomorrow} initialPerson={data.directory.some((d) => d.id === person) ? person : ""} />
        </Card>
      </CountSection>

      <CountSection title="Requests" count={data.requests.length}>
        {data.requests.length ? (
          <Rows>
            {data.requests.map((r) => {
              const people = data.people.get(r.id) ?? [];
              return (
                <Row
                  key={r.id}
                  title={`${r.audienceLabel}, due ${dayText(r.dueOn)}`}
                  meta={[`Asked ${dateLabel(r.requestedAt)} by ${r.requestedByName}.`, `${plural(r.total, "person", "people")}.`, r.note].filter(Boolean).join(" ")}
                  actions={
                    <span className="flex flex-wrap gap-1.5">
                      {r.overdue ? <Chip tone="danger">Past due</Chip> : null}
                      {ORDER.filter((s) => r.counts[s] > 0).map((s) => (
                        <Chip key={s} tone={STATUS[s].tone}>
                          {r.counts[s]} {STATUS[s].label.toLowerCase()}
                        </Chip>
                      ))}
                    </span>
                  }
                >
                  <Disclosure label="Show people" openLabel="Hide people">
                    <ul className="m-0 flex list-none flex-col divide-y divide-divider p-0">
                      {[...people]
                        .sort((a, b) => ORDER.indexOf(a.status) - ORDER.indexOf(b.status))
                        .map((p) => (
                          <li key={p.userId} className="flex items-center justify-between gap-3 py-2 text-sm">
                            <Link href={`/admin/users/${p.userId}#w9`}>{p.name}</Link>
                            <Chip tone={STATUS[p.status].tone}>{STATUS[p.status].label}</Chip>
                          </li>
                        ))}
                    </ul>
                  </Disclosure>
                </Row>
              );
            })}
          </Rows>
        ) : (
          <Card pad={false}>
            <EmptyState title="No requests yet">Ask for a new W-9 when the IRS publishes a new revision, or when one is out of date.</EmptyState>
          </Card>
        )}
      </CountSection>
    </div>
  );
}
