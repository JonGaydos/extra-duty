import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { withTx } from "@/ui/shell/request";
import { userRecord } from "@/domain/admin/views";
import { activeApiKeysOf } from "@/domain/api-keys/api-keys";
import { NotFoundError } from "@/domain/errors";
import { listQualifications } from "@/domain/jobs/qualifications";
import { listRanks } from "@/domain/ranks/ranks";
import { agencyDateOnly, agencyDayKey } from "@/domain/time/agency-time";
import { Card, CardTitle } from "@/ui/components/Card";
import { Chip } from "@/ui/components/Chip";
import { ContactList, EmailLinks, PhoneLink } from "@/ui/components/ContactList";
import { Notice } from "@/ui/components/Notice";
import { PageTitle } from "../../../_personnel/TabLinks";
import { dateLabel, dateTime, dayLabel } from "../../../_personnel/format";
import { ROLE_LABEL } from "../../_admin/labels";
import { managementActor } from "../../_admin/session";
import { AccessActions, EditAccount, GrantFlag, LiftSuspension, ReactivateForm, RevokeFlag, SuspendForm, WriteOffDetail } from "../UserActions";
import { UNPAID_STATUS_LABEL } from "../departure-labels";
import { ButtonLink } from "@/ui/components/Button";
import { dollars } from "@/ui/components/PayLabel";
import { CountSection, Row, Rows } from "../../../coordinate/_coordinator/ui";

export const metadata: Metadata = { title: "User" };

/** "Deactivated on Nov 25, 2026 by Pat Lee: Moved away. Last day Nov 20, 2026." */
function departureText(d: { at: Date; byName: string | null; reason: string | null; lastDay: string | null } | null): string {
  if (!d) return "The account is turned off.";
  const last = d.lastDay ? agencyDateOnly(d.lastDay, "start") : null;
  return `Deactivated on ${dateLabel(d.at)}${d.byName ? ` by ${d.byName}` : ""}${d.reason ? `: ${d.reason}` : ""}.${last ? ` Last day ${dateLabel(last)}.` : ""}`;
}

type Props = { params: Promise<{ id: string }> };

/** One account: its facts, suspension, special flags and access. Coordinators see admin accounts read-only. */
export default async function UserPage({ params }: Props) {
  const actor = await managementActor();
  const { id } = await params;
  const now = new Date();
  const data = await withTx(async (tx) => {
    try {
      const rec = await userRecord(actor, tx, id, now);
      // Turning an admin off stops the API keys they made: an admin deactivating them sees which.
      const apiKeys = actor.role === "admin" && rec.user.role === "admin" && rec.user.active ? await activeApiKeysOf(actor, tx, id, now) : [];
      return { rec, apiKeys, ranks: (await listRanks(tx)).filter((r) => r.active), flags: (await listQualifications(actor, tx)).filter((f) => f.active) };
    } catch (e) {
      if (e instanceof NotFoundError) return null;
      throw e;
    }
  });
  if (!data || data.rec.user.role === "vendor") notFound();
  const { rec, apiKeys, ranks, flags } = data;
  const u = rec.user;
  const held = new Set(rec.flags.map((f) => f.qualificationId));
  const status = !u.active ? "Turned off" : rec.suspended ? "Suspended" : u.lockedAt ? "Locked" : "Active";

  return (
    <div className="flex flex-col gap-4.5">
      <p className="m-0 text-sm">
        <Link href="/admin/users">Users</Link>
      </p>
      <PageTitle>{u.name}</PageTitle>
      {!rec.canChange ? <Notice tone="info">Only admins can change admin accounts.</Notice> : null}
      {!u.active ? (
        <Card tone="danger">
          <CardTitle>Left the agency</CardTitle>
          <p className="m-0 max-w-[70ch]">{departureText(rec.departure)}</p>
          {rec.canChange ? <ReactivateForm userId={u.id} name={u.name} /> : null}
        </Card>
      ) : null}
      {!u.active && (rec.unbilled.length || rec.unpaid.length) ? (
        <div className="grid items-start gap-4.5 md:grid-cols-2">
          <CountSection title="Not billed yet" count={rec.unbilled.length}>
            {rec.unbilled.length ? (
              <Rows tone="warning">
                {rec.unbilled.map((b) => (
                  <Row
                    key={b.assignmentId}
                    title={`#${b.jobNumber} ${b.vendorName}`}
                    href={`/coordinate/details/${b.jobId}`}
                    meta={`${dayLabel(b.startAt)}${b.lateCancel ? ". Late cancel pay" : ""}`}
                    actions={
                      <>
                        <ButtonLink size="sm" href={`/billing/bill/${b.assignmentId}`}>
                          Bill for them
                        </ButtonLink>
                        <WriteOffDetail assignmentId={b.assignmentId} label={`#${b.jobNumber}`} />
                      </>
                    }
                  />
                ))}
              </Rows>
            ) : (
              <p className="m-0 text-muted">Nothing waiting to be billed.</p>
            )}
          </CountSection>
          <CountSection title="Unpaid invoices" count={rec.unpaid.length}>
            {rec.unpaid.length ? (
              <Rows>
                {rec.unpaid.map((i) => (
                  <Row key={i.invoiceId} title={`${i.number} ${i.vendorName}`} href={`/invoices/${i.invoiceId}`} meta={`${dollars(i.totalCents)}. ${UNPAID_STATUS_LABEL[i.status] ?? i.status}. Detail #${i.jobNumber}. Vendors still owe it.`} />
                ))}
              </Rows>
            ) : (
              <p className="m-0 text-muted">No unpaid invoices.</p>
            )}
          </CountSection>
        </div>
      ) : null}
      <div className="grid items-start gap-4.5 md:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)]">
        <div className="flex flex-col gap-4.5">
          <Card>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <CardTitle>Account</CardTitle>
              <Chip tone={status === "Active" ? "success" : status === "Locked" ? "warning" : "danger"}>{status}</Chip>
            </div>
            <ContactList
              items={[
                { label: "Email", value: <EmailLinks emails={[u.email]} /> },
                { label: "Phone", value: u.phone ? <PhoneLink phone={u.phone} /> : null },
                { label: "Role", value: ROLE_LABEL[u.role] },
                { label: "Rank", value: rec.rankName },
                { label: "Badge", value: u.badgeNumber },
                { label: "Mailing address", value: u.mailingAddress ? <span className="whitespace-pre-line">{u.mailingAddress}</span> : null },
                { label: "Last sign-in", value: u.lastSignInAt ? dateTime(u.lastSignInAt) : "Never" },
                { label: "Invite", value: rec.invite ? (rec.invite.usedAt ? `Accepted ${dateLabel(rec.invite.usedAt)}` : `Sent ${dateLabel(rec.invite.sentAt)}, not accepted yet`) : "None sent" },
                { label: "Locked", value: u.lockedAt ? `${dateLabel(u.lockedAt)}${u.lockReason ? `: ${u.lockReason}` : ""}` : null },
              ]}
            />
            {rec.canChange && u.active ? (
              <EditAccount
                userId={u.id}
                ranks={ranks.map((r) => ({ id: r.id, name: r.name }))}
                canPickAdmin={actor.role === "admin"}
                initial={{ name: u.name, phone: u.phone ?? "", role: u.role, rankId: u.rankId ?? "", badgeNumber: u.badgeNumber ?? "" }}
              />
            ) : null}
          </Card>
          <Card>
            <CardTitle>Special flags</CardTitle>
            {rec.flags.length ? (
              <ul className="m-0 flex list-none flex-col divide-y divide-divider p-0">
                {rec.flags.map((f) => (
                  <li key={f.qualificationId} className="flex items-center justify-between gap-3 py-2">
                    <span className="flex flex-col">
                      <span className="font-medium">{f.name}</span>
                      <span className="text-sm text-muted">Since {dateLabel(f.grantedAt)}</span>
                    </span>
                    {rec.canChange ? <RevokeFlag userId={u.id} qualificationId={f.qualificationId} label={f.name} /> : null}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="m-0 text-muted">No special flags.</p>
            )}
            {rec.canChange && u.active ? <GrantFlag userId={u.id} chooseLabel="Flag" choices={flags.filter((f) => !held.has(f.id)).map((f) => ({ id: f.id, name: f.name }))} /> : null}
          </Card>
        </div>
        {rec.canChange && u.active && u.id !== actor.userId ? (
          <div className="flex flex-col gap-4.5">
            <Card tone={rec.suspended ? "danger" : "default"}>
              <CardTitle>Suspension</CardTitle>
              {rec.suspended ? (
                <>
                  <p className="m-0">{u.suspensionReason}</p>
                  <p className="m-0 text-sm text-danger-ink">{u.suspendedUntil ? `Until ${dateLabel(u.suspendedUntil)}.` : "Until a coordinator lifts it."} They cannot sign up for details.</p>
                  <LiftSuspension userId={u.id} />
                </>
              ) : (
                <SuspendForm userId={u.id} today={agencyDayKey(now)} />
              )}
            </Card>
            <Card>
              <CardTitle>Access</CardTitle>
              <AccessActions userId={u.id} name={u.name} canResend={!rec.invite?.usedAt} sent={!!rec.invite} today={agencyDayKey(now)} apiKeys={apiKeys.map((k) => ({ name: k.name, prefix: k.prefix }))} />
            </Card>
          </div>
        ) : null}
      </div>
    </div>
  );
}
