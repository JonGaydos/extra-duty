import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { eq } from "drizzle-orm";
import { withTx } from "@/ui/shell/request";
import { auditLog } from "@/db/schema";
import { whoText } from "@/domain/audit/records";
import { assertMayReadAudit, describeAudit } from "@/domain/audit/search";
import { agencyStamp } from "@/domain/time/agency-time";
import { Card } from "@/ui/components/Card";
import { Chip } from "@/ui/components/Chip";
import { Icon } from "@/ui/icons";
import { managementActor } from "../../../_admin/session";
import { PrintEntryButton } from "../../PrintButton";

export const metadata: Metadata = { title: "Audit entry" };

type Props = { params: Promise<{ id: string }> };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function Fact({ label, children }: Readonly<{ label: string; children: React.ReactNode }>) {
  return (
    <div className="grid gap-0.5 sm:grid-cols-[10rem_minmax(0,1fr)] sm:gap-3">
      <dt className="text-sm font-medium text-muted">{label}</dt>
      <dd className="m-0 break-words">{children}</dd>
    </div>
  );
}

/** One audit entry in full, as the printed record shows it, with Print this entry. */
export default async function AuditEntryPage({ params }: Readonly<Props>) {
  const actor = await managementActor();
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  const entry = await withTx(async (tx) => {
    assertMayReadAudit(actor);
    const rows = await tx.select().from(auditLog).where(eq(auditLog.id, id));
    return rows.length ? (await describeAudit(tx, rows))[0] : null;
  });
  if (!entry) notFound();
  const context = [entry.ipAddress ? `IP address ${entry.ipAddress}` : null, entry.device ? `Device ${entry.device}` : null].filter(Boolean).join(". ") || "No IP address or device recorded.";
  return (
    <div className="mx-auto flex w-full max-w-200 flex-col gap-4.5">
      <Link href="/admin/audit" className="inline-flex min-h-11 w-fit items-center gap-1 text-sm font-semibold">
        <Icon name="chevronLeft" size={18} />
        Back to the audit log
      </Link>
      <div className="flex flex-col gap-1">
        <h1 className="m-0 text-2xl font-bold md:text-3xl">{entry.label}</h1>
        <p className="m-0 text-muted">{agencyStamp(entry.at)}</p>
      </div>
      <Card>
        <dl className="m-0 flex flex-col gap-2.5">
          <Fact label="Entry ID">
            <code className="text-sm break-all">{entry.id}</code>
          </Fact>
          <Fact label="Done by">{entry.system ? <Chip>System</Chip> : whoText(entry)}</Fact>
          <Fact label="Action type">{entry.groupLabel}</Fact>
          <Fact label="About">{entry.detailNumber === null ? entry.subject : <Link href={`/jobs/${entry.detailNumber}`}>{entry.subject}</Link>}</Fact>
          <Fact label="Reason">{entry.reason ?? <span className="text-muted">None given</span>}</Fact>
          <Fact label="System context">{context}</Fact>
        </dl>
      </Card>
      <Card pad={false} aria-labelledby="changes-title">
        <h2 id="changes-title" className="m-0 px-4 pt-4 text-title font-semibold md:px-5.5 md:text-base">
          Changes
        </h2>
        {entry.changes.length === 0 ? (
          <p className="m-0 px-4 pb-4 text-sm text-muted md:px-5.5">No field changes recorded.</p>
        ) : (
          <ul className="m-0 mt-2 list-none divide-y divide-divider p-0">
            {entry.changes.map((c) => (
              <li key={c.field} className="flex flex-col gap-0.5 px-4 py-2.5 md:px-5.5">
                <span className="text-sm font-semibold">{c.field}</span>
                <span className="text-sm break-words">
                  <span className="text-muted">Before:</span> {c.before}
                </span>
                <span className="text-sm break-words">
                  <span className="text-muted">After:</span> {c.after}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>
      <PrintEntryButton id={entry.id} />
    </div>
  );
}
