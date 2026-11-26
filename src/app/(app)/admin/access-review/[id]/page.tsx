import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { inArray } from "drizzle-orm";
import { withTx } from "@/ui/shell/request";
import { users } from "@/db/schema";
import { NotFoundError } from "@/domain/errors";
import { accessReviewReport } from "@/domain/users/access-review";
import { StatTile } from "@/ui/components/StatTile";
import { Table } from "@/ui/components/Table";
import { PageTitle } from "../../../_personnel/TabLinks";
import { dateLabel } from "../../../_personnel/format";
import { DECISION_LABEL, ROLE_LABEL } from "../../_admin/labels";
import { managementActor } from "../../_admin/session";
import type { Role } from "@/domain/actor";

export const metadata: Metadata = { title: "Access review report" };

type Props = { params: Promise<{ id: string }> };

/** Every account in one review with the decision, who made it and when. */
export default async function AccessReviewReportPage({ params }: Readonly<Props>) {
  const actor = await managementActor();
  const { id } = await params;
  const data = await withTx(async (tx) => {
    try {
      const report = await accessReviewReport(actor, tx, id);
      const deciders = [...new Set(report.items.map((i) => i.decidedBy).filter((x): x is string => !!x))];
      const names = new Map(deciders.length ? (await tx.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, deciders))).map((u) => [u.id, u.name]) : []);
      return { report, names };
    } catch (e) {
      if (e instanceof NotFoundError) return null;
      throw e;
    }
  });
  if (!data) notFound();
  const { report, names } = data;
  const r = report.review;
  const progress = r.completedAt ? `Finished ${dateLabel(r.completedAt)}.` : `Due ${dateLabel(r.dueAt)}, still open.`;
  return (
    <div className="flex flex-col gap-4.5">
      <p className="m-0 text-sm">
        <Link href="/admin/access-review">Access review</Link>
      </p>
      <PageTitle sub={`Started ${dateLabel(r.startedAt)}. ${progress}`}>Access review report</PageTitle>
      <div className="grid grid-cols-2 gap-2.5 md:grid-cols-4">
        <StatTile label="Kept" value={String(report.counts.keep)} />
        <StatTile label="Need change" value={String(report.counts.change)} />
        <StatTile label="Turned off" value={String(report.counts.deactivate)} />
        <StatTile label="Not decided" value={String(report.counts.pending)} tone={report.counts.pending ? "warning" : undefined} />
      </div>
      <Table
        caption="Accounts"
        rows={report.items}
        rowKey={(i) => i.id}
        columns={[
          { header: "Person", render: (i) => <span className="flex flex-col"><span className="font-medium">{i.userName}</span><span className="text-sm text-muted">{i.userEmail}</span></span> },
          { header: "Role", render: (i) => ROLE_LABEL[i.userRole as Role] ?? i.userRole },
          { header: "Decision", render: (i) => (i.decision ? DECISION_LABEL[i.decision] : "Not decided") },
          { header: "Note", render: (i) => i.note ?? "" },
          { header: "Decided by", render: (i) => (i.decidedBy ? (names.get(i.decidedBy) ?? "") : "") },
          { header: "When", render: (i) => (i.decidedAt ? dateLabel(i.decidedAt) : "") },
        ]}
      />
    </div>
  );
}
