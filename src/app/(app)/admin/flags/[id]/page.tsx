import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { withTx } from "@/ui/shell/request";
import { flagRecord } from "@/domain/admin/views";
import { NotFoundError } from "@/domain/errors";
import { Card, CardTitle } from "@/ui/components/Card";
import { Chip } from "@/ui/components/Chip";
import { EmptyState } from "@/ui/components/EmptyState";
import { PageTitle } from "../../../_personnel/TabLinks";
import { dateLabel } from "../../../_personnel/format";
import { CountSection } from "../../../coordinate/_coordinator/ui";
import { managementActor } from "../../_admin/session";
import { GrantFlag, RevokeFlag } from "../../users/UserActions";

export const metadata: Metadata = { title: "Special flag" };

type Props = { params: Promise<{ id: string }> };

/** Who holds one flag; grant it to someone or revoke it. */
export default async function FlagPage({ params }: Props) {
  const actor = await managementActor();
  const { id } = await params;
  const rec = await withTx(async (tx) => {
    try {
      return await flagRecord(actor, tx, id);
    } catch (e) {
      if (e instanceof NotFoundError) return null;
      throw e;
    }
  });
  if (!rec) notFound();
  return (
    <div className="flex flex-col gap-4.5">
      <p className="m-0 text-sm">
        <Link href="/admin/flags">Special flags</Link>
      </p>
      <PageTitle action={!rec.flag.active ? <Chip>Off</Chip> : undefined}>{rec.flag.name}</PageTitle>
      <CountSection title="People who hold it" count={rec.holders.length}>
        {rec.holders.length ? (
          <Card pad={false} as="div">
            <ul className="m-0 list-none divide-y divide-divider p-0">
              {rec.holders.map((h) => (
                <li key={h.userId} className="flex items-center justify-between gap-3 px-4 py-3.25">
                  <span className="flex min-w-0 flex-col gap-0.5">
                    <Link href={`/admin/users/${h.userId}`} className="font-semibold text-ink hover:text-link">
                      {h.name}
                    </Link>
                    <span className="text-sm text-muted">
                      {h.rankName ? `${h.rankName}. ` : ""}Since {dateLabel(h.grantedAt)}
                    </span>
                  </span>
                  {h.canChange ? <RevokeFlag userId={h.userId} qualificationId={rec.flag.id} label={`${rec.flag.name} from ${h.name}`} /> : <span className="text-sm text-muted">Admin account</span>}
                </li>
              ))}
            </ul>
          </Card>
        ) : (
          <Card pad={false}>
            <EmptyState title="Nobody holds it yet">Grant it below, or approve a request on Special flags.</EmptyState>
          </Card>
        )}
      </CountSection>
      {rec.flag.active ? (
        <Card>
          <CardTitle>Grant this flag</CardTitle>
          <GrantFlag qualificationId={rec.flag.id} chooseLabel="Person" choices={rec.candidates} />
        </Card>
      ) : null}
    </div>
  );
}
