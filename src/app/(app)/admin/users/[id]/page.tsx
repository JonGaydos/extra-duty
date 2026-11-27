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
import { AccessActions, EditAccount, GrantFlag, ManagedVendors, LiftSuspension, ReactivateForm, RevokeFlag, SuspendForm, WriteOffDetail } from "../UserActions";
import { UNPAID_STATUS_LABEL } from "../departure-labels";
import { ActionLink, ButtonLink } from "@/ui/components/Button";
import { dollars } from "@/ui/components/PayLabel";
import { CountSection, Row, Rows } from "../../../coordinate/_coordinator/ui";
import { Disclosure } from "@/ui/components/Disclosure";
import { Icon } from "@/ui/icons";
import { W9_FORM_REVISIONS, w9History, type W9HistoryRow } from "@/domain/w9/w9";
import { signedText, W9StatusChip } from "../../../_shared/w9";
import { W9Upload } from "../../../profile/forms";
import { W9Review } from "../W9Review";
import { managedVendorIdsOf } from "@/domain/vendors/managers";
import { vendorDirectory } from "@/domain/coordinator/views";

export const metadata: Metadata = { title: "User" };

/** "Deactivated on Nov 25, 2026 by Pat Lee: Moved away. Last day Nov 20, 2026." */
function departureText(d: { at: Date; byName: string | null; reason: string | null; lastDay: string | null } | null): string {
  if (!d) return "The account is turned off.";
  const last = d.lastDay ? agencyDateOnly(d.lastDay, "start") : null;
  const by = d.byName ? ` by ${d.byName}` : "";
  const reason = d.reason ? `: ${d.reason}` : "";
  const lastDay = last ? ` Last day ${dateLabel(last)}.` : "";
  return `Deactivated on ${dateLabel(d.at)}${by}${reason}.${lastDay}`;
}

type Props = { params: Promise<{ id: string }> };
type UserRec = Awaited<ReturnType<typeof userRecord>>;
type Status = "Turned off" | "Suspended" | "Locked" | "Active";

const STATUS_TONE = { Active: "success", Locked: "warning", Suspended: "danger", "Turned off": "danger" } as const;

function accountStatus(rec: UserRec): Status {
  if (!rec.user.active) return "Turned off";
  if (rec.suspended) return "Suspended";
  return rec.user.lockedAt ? "Locked" : "Active";
}

function inviteText(invite: UserRec["invite"]): string {
  if (!invite) return "None sent";
  return invite.usedAt ? `Accepted ${dateLabel(invite.usedAt)}` : `Sent ${dateLabel(invite.sentAt)}, not accepted yet`;
}

function lockedText(u: UserRec["user"]): string | null {
  if (!u.lockedAt) return null;
  const reason = u.lockReason ? `: ${u.lockReason}` : "";
  return `${dateLabel(u.lockedAt)}${reason}`;
}

/** A turned-off account: how it left, with Reactivate for those who may change it. */
function LeftAgency({ rec }: Readonly<{ rec: UserRec }>) {
  const u = rec.user;
  if (u.active) return null;
  return (
    <Card tone="danger">
      <CardTitle>Left the agency</CardTitle>
      <p className="m-0 max-w-[70ch]">{departureText(rec.departure)}</p>
      {rec.canChange ? <ReactivateForm userId={u.id} name={u.name} /> : null}
    </Card>
  );
}

/** What a turned-off account still has open: details not billed yet and invoices not paid. */
function LeftOpenWork({ rec }: Readonly<{ rec: UserRec }>) {
  if (rec.user.active || !(rec.unbilled.length || rec.unpaid.length)) return null;
  return (
    <div className="grid items-start gap-4.5 md:grid-cols-2">
      <CountSection title="Not billed yet" count={rec.unbilled.length}>
        {rec.unbilled.length ? (
          <Rows tone="warning">
            {rec.unbilled.map((b) => (
              <Row
                key={b.assignmentId}
                title={`#${b.jobNumber} ${b.vendorName}`}
                href={`/jobs/${b.jobId}?tab=manage`}
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
  );
}

/** The account's facts and status, with the edit form for those who may change it. */
function AccountCard({ rec, ranks, canPickAdmin }: Readonly<{ rec: UserRec; ranks: Array<{ id: string; name: string }>; canPickAdmin: boolean }>) {
  const u = rec.user;
  const status = accountStatus(rec);
  return (
    <Card>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <CardTitle>Account</CardTitle>
        <Chip tone={STATUS_TONE[status]}>{status}</Chip>
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
          { label: "Invite", value: inviteText(rec.invite) },
          { label: "Locked", value: lockedText(u) },
        ]}
      />
      {rec.canChange && u.active ? (
        <EditAccount
          userId={u.id}
          ranks={ranks.map((r) => ({ id: r.id, name: r.name }))}
          canPickAdmin={canPickAdmin}
          initial={{ name: u.name, phone: u.phone ?? "", role: u.role, rankId: u.rankId ?? "", badgeNumber: u.badgeNumber ?? "" }}
        />
      ) : null}
    </Card>
  );
}

/** The person's special flags, with Revoke and Grant for those who may change them. */
function FlagsCard({ rec, flags }: Readonly<{ rec: UserRec; flags: Array<{ id: string; name: string }> }>) {
  const u = rec.user;
  const held = new Set(rec.flags.map((f) => f.qualificationId));
  return (
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
  );
}

/**
 * Vendors this deputy manages (owner decision 2026-11-27): for these only they create and staff details, decide the
 * vendor's requests and keep its locations and site contacts.
 */
function ManagedVendorsCard({ rec, vendors, managed }: Readonly<{ rec: UserRec; vendors: Array<{ id: string; name: string; active: boolean }>; managed: string[] }>) {
  const u = rec.user;
  const names = vendors.filter((v) => managed.includes(v.id)).map((v) => v.name);
  // Inactive vendors are offered only when already chosen, so they can be cleared.
  const choices = vendors.filter((v) => v.active || managed.includes(v.id)).map((v) => ({ id: v.id, name: v.active ? v.name : `${v.name} (inactive)` }));
  return (
    <Card id="managed-vendors" className="scroll-mt-24">
      <CardTitle>Vendor manager</CardTitle>
      <p className="m-0 max-w-[70ch] text-sm text-muted">
        For the vendors chosen here, {u.name} creates, edits and staffs details, decides the vendor&apos;s requests and keeps its locations and site contacts. Everything else stays as for any deputy.
      </p>
      {rec.canChange && u.active ? (
        <ManagedVendors userId={u.id} vendors={choices} initial={managed} />
      ) : (
        <p className="m-0">{names.length ? names.join(", ") : "No vendors."}</p>
      )}
    </Card>
  );
}

/** The person's W-9s, newest first: review the latest while it is pending, download it (logged) or upload one for them. */
function W9Card({ rec, history, today }: Readonly<{ rec: UserRec; history: W9HistoryRow[]; today: string }>) {
  const u = rec.user;
  const [latest, ...older] = history;
  const by = (h: W9HistoryRow) => (h.uploadedByName ? ` by ${h.uploadedByName}` : "");
  return (
    <Card id="w9" className="scroll-mt-24">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <CardTitle>W-9</CardTitle>
        {latest ? <W9StatusChip status={latest.status} /> : null}
      </div>
      {latest ? (
        <div className="flex flex-col gap-1 text-sm">
          <p className="m-0 flex flex-wrap items-center gap-x-3">
            Uploaded {dateLabel(latest.uploadedAt)}
            {by(latest)}.
            <a href={`/api/v1/users/${u.id}/w9`} className="inline-flex min-h-11 items-center gap-1 font-semibold" download>
              <Icon name="download" size={16} />
              Download
              <span className="sr-only">, logged under your name</span>
            </a>
          </p>
          {latest.status === "approved" ? <p className="m-0 text-muted">{signedText(latest)}. Approved{latest.reviewedByName ? ` by ${latest.reviewedByName}` : ""}.</p> : null}
          {latest.status === "rejected" ? <p className="m-0 text-danger-ink">Not approved: {latest.rejectReason}</p> : null}
          <p className="m-0 text-xs text-muted">Every download is kept in the audit log. W-9s hold Social Security numbers.</p>
        </div>
      ) : (
        <p className="m-0 text-sm text-muted">No W-9 on file. They cannot sign up for details until one is approved.</p>
      )}
      {latest?.status === "pending" ? <W9Review w9Id={latest.id} name={u.name} today={today} revisions={W9_FORM_REVISIONS} /> : null}
      {older.length ? (
        <Disclosure label={`Earlier W-9s (${older.length})`} openLabel="Hide earlier W-9s">
          <ul className="m-0 flex list-none flex-col divide-y divide-divider p-0">
            {older.map((h) => (
              <li key={h.id} className="flex flex-col gap-1 py-2 text-sm">
                <span className="flex flex-wrap items-center gap-2">
                  <W9StatusChip status={h.status} />
                  Uploaded {dateLabel(h.uploadedAt)}
                  {by(h)}
                </span>
                <span className="text-muted">{h.status === "rejected" ? `Not approved: ${h.rejectReason}` : null}{h.status === "approved" ? signedText(h) : null}</span>
              </li>
            ))}
          </ul>
        </Disclosure>
      ) : null}
      {u.active ? <W9Upload hasW9={history.length > 0} url={`/api/v1/users/${u.id}/w9`} forName={u.name} /> : null}
      {u.active ? (
        <ActionLink href={`/admin/w9?person=${u.id}`}>Ask {u.name} for a new W-9</ActionLink>
      ) : null}
    </Card>
  );
}

/** Suspension and access for an active account someone else may change. */
function ManageCards({ rec, today, apiKeys }: Readonly<{ rec: UserRec; today: string; apiKeys: Array<{ name: string; prefix: string }> }>) {
  const u = rec.user;
  return (
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
          <SuspendForm userId={u.id} today={today} />
        )}
      </Card>
      <Card>
        <CardTitle>Access</CardTitle>
        <AccessActions userId={u.id} name={u.name} canResend={!rec.invite?.usedAt} sent={!!rec.invite} today={today} apiKeys={apiKeys.map((k) => ({ name: k.name, prefix: k.prefix }))} />
      </Card>
    </div>
  );
}

/** One account: its facts, suspension, special flags and access. Coordinators see admin accounts read-only. */
export default async function UserPage({ params }: Readonly<Props>) {
  const actor = await managementActor();
  const { id } = await params;
  const now = new Date();
  const data = await withTx(async (tx) => {
    try {
      const rec = await userRecord(actor, tx, id, now);
      // Turning an admin off stops the API keys they made: an admin deactivating them sees which.
      const apiKeys = actor.role === "admin" && rec.user.role === "admin" && rec.user.active ? await activeApiKeysOf(actor, tx, id, now) : [];
      const w9 = rec.user.role === "vendor" ? [] : await w9History(actor, tx, id);
      const vendorList = rec.user.role === "personnel" ? await vendorDirectory(actor, tx, now) : [];
      const managed = rec.user.role === "personnel" ? await managedVendorIdsOf(tx, id) : [];
      return { rec, apiKeys, w9, vendorList, managed, ranks: (await listRanks(tx)).filter((r) => r.active), flags: (await listQualifications(actor, tx)).filter((f) => f.active) };
    } catch (e) {
      if (e instanceof NotFoundError) return null;
      throw e;
    }
  });
  if (!data || data.rec.user.role === "vendor") notFound();
  const { rec, apiKeys, ranks, flags, w9, vendorList, managed } = data;
  const u = rec.user;

  return (
    <div className="flex flex-col gap-4.5">
      <p className="m-0 text-sm">
        <Link href="/admin/users">Users</Link>
      </p>
      <PageTitle>{u.name}</PageTitle>
      {!rec.canChange ? <Notice tone="info">Only admins can change admin accounts.</Notice> : null}
      <LeftAgency rec={rec} />
      <LeftOpenWork rec={rec} />
      <div className="grid items-start gap-4.5 md:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)]">
        <div className="flex flex-col gap-4.5">
          <AccountCard rec={rec} ranks={ranks} canPickAdmin={actor.role === "admin"} />
          <FlagsCard rec={rec} flags={flags} />
          {u.role === "personnel" ? <ManagedVendorsCard rec={rec} vendors={vendorList} managed={managed} /> : null}
          <W9Card rec={rec} history={w9} today={agencyDayKey(now)} />
        </div>
        {rec.canChange && u.active && u.id !== actor.userId ? <ManageCards rec={rec} today={agencyDayKey(now)} apiKeys={apiKeys} /> : null}
      </div>
    </div>
  );
}
