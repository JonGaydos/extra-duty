import type { Metadata } from "next";
import Link from "next/link";
import { withTx } from "@/ui/shell/request";
import { accessReviewOverview } from "@/domain/admin/views";
import { getSettings } from "@/domain/settings/settings";
import { agencyDayKey } from "@/domain/time/agency-time";
import { Card, CardTitle } from "@/ui/components/Card";
import { EmptyState } from "@/ui/components/EmptyState";
import { Notice } from "@/ui/components/Notice";
import { PageTitle } from "../../_personnel/TabLinks";
import { dateLabel, plural } from "../../_personnel/format";
import { CountSection, Row, Rows } from "../../coordinate/_coordinator/ui";
import { saveSettingsAction } from "../_admin/actions";
import { SettingsForm } from "../_admin/forms";
import { ROLE_LABEL } from "../_admin/labels";
import { managementActor } from "../_admin/session";
import { GROUPS, groupValues } from "../_admin/settings-groups";
import { DecideItem, StartReview } from "./ReviewActions";

export const metadata: Metadata = { title: "Access review" };

const lastSignIn = (at: Date | null) => (at ? `Last signed in ${dateLabel(at)}` : "Never signed in");

/** The yearly check that every account should still exist: decide each one, then keep the report. */
export default async function AccessReviewPage() {
  const actor = await managementActor();
  const { review, settings } = await withTx(async (tx) => ({ review: await accessReviewOverview(actor, tx), settings: await getSettings(tx) }));
  const now = new Date();
  const open = review.open;
  const group = GROUPS["access-review"];
  return (
    <div className="flex flex-col gap-4.5">
      <PageTitle sub="Confirm every account still needs access. Starts on its own on the review date.">Access review</PageTitle>
      {open ? (
        <>
          <Card tone={open.dueAt < now ? "danger" : "default"}>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <CardTitle>Review started {dateLabel(open.startedAt)}</CardTitle>
              <Link href={`/admin/access-review/${open.id}`}>Report</Link>
            </div>
            <p className="m-0">
              <span data-numeric className="font-semibold">
                {open.decided} of {open.total}
              </span>{" "}
              accounts decided. {open.dueAt < now ? `It was due ${dateLabel(open.dueAt)}.` : `Due ${dateLabel(open.dueAt)}.`}
            </p>
            <div className="h-2 overflow-hidden rounded-full bg-sunken" aria-hidden="true">
              <div className="h-full bg-accent" style={{ width: `${open.total ? Math.round((open.decided / open.total) * 100) : 0}%` }} />
            </div>
          </Card>
          <CountSection title="Still to decide" count={open.pending.length}>
            <Rows>
              {open.pending.map((p) => (
                <Row
                  key={p.itemId}
                  title={p.name}
                  href={p.role === "vendor" ? undefined : `/admin/users/${p.userId}`}
                  meta={`${p.email}. ${ROLE_LABEL[p.role]}. ${lastSignIn(p.lastSignInAt)}`}
                  actions={<DecideItem itemId={p.itemId} name={p.name} canDeactivate={p.role !== "admin" || actor.role === "admin"} today={agencyDayKey(now)} />}
                />
              ))}
            </Rows>
          </CountSection>
        </>
      ) : (
        <Card>
          <CardTitle>No review open</CardTitle>
          <p className="m-0 max-w-[70ch] text-muted">Starting one now lists every active account, vendor logins included. You have 30 days to decide each one.</p>
          <StartReview />
        </Card>
      )}
      <div className="grid items-start gap-4.5 md:grid-cols-2">
        <CountSection title="Earlier reviews" count={review.past.length}>
          {review.past.length ? (
            <Rows>
              {review.past.map((r) => (
                <Row key={r.id} title={`Started ${dateLabel(r.startedAt)}`} href={`/admin/access-review/${r.id}`} meta={`Finished ${r.completedAt ? dateLabel(r.completedAt) : ""}. ${plural(r.total, "account")}`} />
              ))}
            </Rows>
          ) : (
            <Card pad={false}>
              <EmptyState title="No finished reviews">Each finished review keeps a report here.</EmptyState>
            </Card>
          )}
        </CountSection>
        <CountSection title="Schedule">
          <Card>
            <SettingsForm slug={group.slug} fields={group.fields} initial={groupValues(group, settings)} save={saveSettingsAction} saveLabel={group.save} />
            {!open ? <Notice tone="info">The next review starts on its own on the review date.</Notice> : null}
          </Card>
        </CountSection>
      </div>
    </div>
  );
}
