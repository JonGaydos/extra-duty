import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { withTx } from "@/ui/shell/request";
import { detailFormOptions, jobAdmin, rateOverrideOf, staffDirectory } from "@/domain/coordinator/views";
import { deputyNotesForJob } from "@/domain/deputy-notes/deputy-notes";
import { NotFoundError } from "@/domain/errors";
import { loadJobStatus, type JobDisplayStatus } from "@/domain/jobs/status";
import { getJob, reactivationPreview } from "@/domain/jobs/jobs";
import type { DetailEvent } from "@/domain/assignments/history";
import { eligibleReviewers, getJobOpsPlan } from "@/domain/ops-plans/ops-plans";
import { jobActivity } from "@/domain/personnel/views";
import { getSettings } from "@/domain/settings/settings";
import { agencyDateParts, agencyDayKey } from "@/domain/time/agency-time";
import { ActionLink } from "@/ui/components/Button";
import { Card, CardTitle } from "@/ui/components/Card";
import { Chip } from "@/ui/components/Chip";
import { Notice } from "@/ui/components/Notice";
import { PayLabel, dollars } from "@/ui/components/PayLabel";
import { SiteContact } from "@/ui/components/ContactList";
import { MapsLink } from "@/ui/components/MapsLink";
import { outsideRange } from "@/domain/jobs/rate";
import { RateOverrideNote } from "../../_coordinator/rate-override";
import { DetailInvoiceHold } from "../../_coordinator/ChoiceSave";
import { StaffingGrid } from "@/ui/components/StaffingGrid";
import { Icon } from "@/ui/icons";
import { clock, dateLabel, dateTime, plural, timeRange, whenText } from "../../../_personnel/format";
import { coordinatorActor } from "../../_coordinator/session";
import { QuickEdit } from "../../_coordinator/EditPanel";
import { editBlockReason } from "@/domain/jobs/bulk-edit";
import { Facts } from "../../_coordinator/ui";
import type { DetailWire } from "../../_coordinator/detail-input";
import { MAX_FILE_BYTES } from "@/domain/files/files";
import {
  AssignForm,
  AttachContract,
  CancelDetail,
  ChangeDecision,
  CopyDetail,
  EditDetail,
  OpsPlanReview,
  HoldRelease,
  ReactivateDetail,
  RepeatDetail,
  RequestDecision,
  RosterRowActions,
  SafetyEditor,
  WaiveLateCancel,
} from "./DetailActions";

export const metadata: Metadata = { title: "Detail" };

type Props = { params: Promise<{ id: string }> };

/** "Canceled by Pat Lee on Nov 24, 2026 at 3:00 PM: Wrong date", for staff. */
const eventLine = (e: DetailEvent) => `${e.kind === "canceled" ? "Canceled" : "Reactivated"} by ${e.by ?? "the system"} on ${dateTime(e.at)}${e.reason ? `: ${e.reason}` : ""}`;

const hhmm = (d: Date) => {
  const p = agencyDateParts(d);
  return `${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`;
};

/** The statuses a detail takes once it has ended. */
const ENDED: Partial<Record<JobDisplayStatus, { tone: "attention" | "info" | "success" | "neutral"; text: string }>> = {
  ready_to_bill: { tone: "attention", text: "Ready to bill" },
  billed: { tone: "info", text: "Billed" },
  closed: { tone: "success", text: "Closed" },
};

/** A detail as a coordinator runs it: request decision, edit (one or series), roster actions, ops plan review, copy, repeat and cancel. */
export default async function CoordinatorDetailPage({ params }: Props) {
  const actor = await coordinatorActor();
  const { id } = await params;
  const now = new Date();
  const data = await withTx(async (tx) => {
    let job;
    try {
      job = await getJob(actor, tx, id);
    } catch (e) {
      if (e instanceof NotFoundError) return null;
      throw e;
    }
    const admin = await jobAdmin(actor, tx, id);
    const ops = job.opsPlanRequired ? await getJobOpsPlan(actor, tx, id) : null;
    const latest = ops?.versions.at(-1);
    const settings = await getSettings(tx);
    const canReview =
      !!ops?.opsPlanId && !!latest && latest.decision === "pending" && settings.opsPlanReviewerUserIds.includes(actor.userId) && (await eligibleReviewers(tx, id, latest.submittedBy)).includes(actor.userId);
    const people = await staffDirectory(actor, tx);
    return {
      job,
      admin,
      ops,
      canReview,
      people: people.filter((p) => p.role !== "vendor"),
      notes: await deputyNotesForJob(actor, tx, id),
      activity: await jobActivity(actor, tx, id, 20),
      options: await detailFormOptions(actor, tx, now),
      rateOverride: await rateOverrideOf(tx, job),
      rateOutside: outsideRange(job.rateCents, settings),
      agencyWait: settings.waitForAllDeputies,
      // A canceled detail can come back until it ends.
      reactivation: job.state === "canceled" && now.getTime() < job.endAt.getTime() ? await reactivationPreview(actor, tx, id) : null,
      status: await loadJobStatus(tx, id, now),
    };
  });
  if (!data) notFound();
  const { job, admin, ops } = data;
  const started = job.startAt.getTime() <= now.getTime();
  const closed = job.state === "canceled" || job.state === "declined";
  const icPosition = admin.positions.some((p) => p.isIncidentCommander);
  const latest = ops?.versions.at(-1);
  const initial: DetailWire = {
    vendorId: job.vendorId,
    locationId: job.locationId ?? "",
    typeId: job.typeId,
    title: job.title,
    description: job.description ?? "",
    notes: job.notes ?? "",
    startTime: hhmm(job.startAt),
    endTime: hhmm(job.endAt),
    rate: String(job.rateCents / 100),
    positions: job.positions.map((p) => ({ positionTypeId: p.positionTypeId, count: p.count })),
    opsPlanRequired: job.opsPlanRequired,
    contactName: job.contactName ?? "",
    contactPhone: job.contactPhone ?? "",
    held: job.held,
    flex: job.flexEarliestStartAt && job.flexLatestEndAt ? { earliest: hhmm(job.flexEarliestStartAt), latest: hhmm(job.flexLatestEndAt), allowShorter: job.flexAllowShorter } : null,
    safetyNotes: "",
    safetyAddresses: [],
  };
  const quickBlock = editBlockReason(job, now);
  // Sign-ups and the detail's cancels and reactivations, in the order they happened.
  type HistoryItem = { at: number; row: (typeof admin.roster)[number]; event?: undefined } | { at: number; event: DetailEvent; row?: undefined };
  const history: HistoryItem[] = [
    ...admin.roster.map((row) => ({ at: row.requestedAt.getTime(), row })),
    ...admin.events.map((event) => ({ at: event.at.getTime(), event })),
  ].sort((a, b) => a.at - b.at);
  const releaseStatus = job.held
    ? "Held: off the open lists and no new sign-ups. People already on it keep their spots."
    : job.state === "requested"
      ? "After approval"
      : job.releaseAt
        ? job.releaseAt.getTime() <= now.getTime()
          ? `Open for sign-up since ${dateTime(job.releaseAt)}`
          : `Opens ${dateTime(job.releaseAt)}`
        : "After approval";
  const ended = ENDED[data.status];
  const stateChip =
    job.state === "requested" ? (
      <Chip tone="warning">Vendor request</Chip>
    ) : job.state === "declined" ? (
      <Chip>Declined</Chip>
    ) : job.state === "canceled" ? (
      <Chip tone="danger">Canceled</Chip>
    ) : ended ? (
      <Chip tone={ended.tone}>{ended.text}</Chip>
    ) : started ? (
      <Chip>Started</Chip>
    ) : job.held ? null : job.releaseAt && job.releaseAt.getTime() <= now.getTime() ? (
      <Chip tone="success">Released</Chip>
    ) : (
      <Chip tone="info">Not released</Chip>
    );

  return (
    <div className="flex flex-col gap-4.5">
      <Link href="/coordinate/details" className="inline-flex min-h-11 w-fit items-center gap-1 text-sm font-semibold">
        <Icon name="chevronLeft" size={18} />
        Back to details
      </Link>
      <div className="flex flex-col gap-1.5">
        <div className="flex flex-wrap gap-1.5">
          <Chip>#{job.number}</Chip>
          {stateChip}
          {job.held ? <Chip tone="warning">Held</Chip> : null}
          {admin.locked ? <Chip tone="danger">Locked: vendor on payment hold</Chip> : null}
          {admin.seriesCount > 1 ? <Chip>Series of {admin.seriesCount}</Chip> : null}
          {job.contractStatus === "missing" ? <Chip tone="warning">No contract</Chip> : null}
          {data.rateOutside && !data.rateOverride ? <Chip tone="warning">Rate outside the agency range</Chip> : null}
        </div>
        <h1 className="m-0 text-2xl font-bold md:text-3xl">{job.title}</h1>
        <p className="m-0 text-muted">
          <Link href={`/coordinate/vendors/${job.vendorId}`}>{admin.vendorName}</Link>
          {admin.locationName ? `, ${admin.locationName}` : ""}
        </p>
      </div>

      <div className="grid gap-4.5 md:grid-cols-[minmax(0,1fr)_340px] md:grid-rows-[auto_1fr] md:items-start md:gap-6">
        {/* Manage comes first on phones; on desktop it heads the right column. */}
        <div className="flex flex-col gap-4.5 md:col-start-2 md:row-start-1">
          {job.state !== "requested" ? (
            <Card>
              <CardTitle>Quick edit</CardTitle>
              {quickBlock ? (
                <p className="m-0 text-sm text-muted" data-testid="quick-edit-closed">
                  {quickBlock} Quick edit is for details that have not started.
                </p>
              ) : (
              <QuickEdit
                key={JSON.stringify([initial.rate, initial.startTime, initial.endTime, initial.description, initial.positions])}
                jobId={job.id}
                initial={{ rate: initial.rate, startTime: initial.startTime, endTime: initial.endTime, description: initial.description, positions: initial.positions }}
                types={data.options.positionTypes}
                defaultTypeId={data.options.defaultPositionTypeId ?? data.options.positionTypes[0]?.id ?? ""}
                seriesLater={admin.laterInSeries}
                started={started}
                range={data.options.rateRange}
                approved={!!data.rateOverride}
              />
              )}
            </Card>
          ) : null}
          <Card>
            <CardTitle>Manage</CardTitle>
            {!closed ? (
              <EditDetail jobId={job.id} initial={initial} date={agencyDayKey(job.startAt)} options={data.options} seriesLater={admin.laterInSeries} started={started} approved={!!data.rateOverride} />
            ) : null}
            {!closed && job.state !== "requested" && !started ? (
              <HoldRelease jobId={job.id} held={job.held} opensLater={!!job.releaseAt && job.releaseAt.getTime() > now.getTime()} seriesLater={admin.laterInSeries} status={releaseStatus} />
            ) : null}
            {job.state !== "requested" && job.state !== "declined" ? <DetailInvoiceHold jobId={job.id} current={job.waitForAllDeputies} agency={data.agencyWait} /> : null}
            {job.state !== "requested" && job.state !== "declined" ? (
              <ActionLink href={`/jobs/${job.id}`}>Open the deputy view</ActionLink>
            ) : null}
            {data.reactivation ? <ReactivateDetail jobId={job.id} preview={data.reactivation} /> : null}
            {job.state === "canceled" && admin.lateCanceled > 0 && !job.lateCancelWaivedReason ? (
              <>
                <Notice tone="warning">{plural(admin.lateCanceled, "person is", "people are")} paid for this late cancellation.</Notice>
                <WaiveLateCancel jobId={job.id} />
              </>
            ) : null}
            {!closed && !started ? <CancelDetail jobId={job.id} locked={admin.locked} latePayDefault={admin.latePay} /> : null}
            {!closed && started && admin.locked ? <CancelDetail jobId={job.id} locked latePayDefault={admin.latePay} /> : null}
          </Card>
        </div>

        <div className="flex min-w-0 flex-col gap-4.5 md:col-start-1 md:row-span-2 md:row-start-1">
          {job.state === "requested" ? (
            <Card tone="accent">
              <CardTitle>Vendor request</CardTitle>
              <p className="m-0 text-sm text-muted">Approving publishes it under the normal release rules. Declining tells the vendor your reason.</p>
              <RequestDecision jobId={job.id} dates={Math.max(1, admin.seriesCount)} />
            </Card>
          ) : null}

          {admin.pendingChanges.length ? (
            <Card tone="warning">
              <CardTitle>Change requested by the vendor</CardTitle>
              {admin.pendingChanges.map((c) => (
                <div key={c.id} className="flex flex-col gap-2">
                  <p className="m-0 text-sm text-warning-ink">
                    Asked {dateTime(c.requestedAt)}: {describePatch(c.patch)}
                  </p>
                  <ChangeDecision requestId={c.id} jobId={job.id} />
                </div>
              ))}
            </Card>
          ) : null}

          <Card>
            <Facts
              items={[
                ["When", whenText(job.startAt, job.endAt, now)],
                ...(job.flexEarliestStartAt && job.flexLatestEndAt ? ([["Flexible", `${timeRange(job.flexEarliestStartAt, job.flexLatestEndAt)}${job.flexAllowShorter ? ", shorter shifts allowed" : ""}`]] as Array<[string, string]>) : []),
                [
                  "Pay",
                  <span key="pay">
                    <PayLabel variant="plain" totalCents={admin.totalCents} rateCents={job.rateCents} />
                    {admin.positions
                      .filter((p) => p.differentialCents !== 0)
                      .map((p) => (
                        <span key={p.id} className="block text-sm text-muted">
                          {p.name}: <PayLabel variant="plain" totalCents={p.totalCents} rateCents={p.rateCents} />
                        </span>
                      ))}
                    <span className="block text-sm text-muted" data-numeric>
                      Vendor total when full: {dollars(admin.vendorTotalCents)}
                    </span>
                    {data.rateOverride ? <RateOverrideNote override={data.rateOverride} /> : null}
                  </span>,
                ],
                ["Type", admin.typeName],
                [
                  "Place",
                  <span key="place" className="flex flex-col">
                    <span>{admin.locationAddress ? `${admin.locationName}, ${admin.locationAddress}` : (admin.locationName ?? "No set location")}</span>
                    {admin.locationAddress || admin.locationPin ? <MapsLink address={admin.locationAddress} lat={admin.locationPin?.lat} lng={admin.locationPin?.lng} /> : null}
                  </span>,
                ],
                ["Contact on site", job.contactName || job.contactPhone ? <SiteContact key="contact" name={job.contactName} phone={job.contactPhone} staff /> : "None given"],
                ["Release", releaseStatus],
              ]}
            />
            {job.description ? <p className="m-0 max-w-[70ch] whitespace-pre-line">{job.description}</p> : null}
            {job.notes ? <p className="m-0 max-w-[70ch] text-sm whitespace-pre-line text-muted">Notes for deputies: {job.notes}</p> : null}
            {job.state === "canceled" ? <Notice tone="danger">Canceled{job.cancelReason ? `: ${job.cancelReason}` : "."}</Notice> : null}
          </Card>

          <Card tone={job.safety ? "danger" : "default"}>
            <CardTitle>Officer safety</CardTitle>
            {job.safety ? (
              <>
                {job.safety.notes ? <p className="m-0 max-w-[70ch] text-danger-ink">{job.safety.notes}</p> : null}
                {job.safety.addresses.length ? (
                  <ul className="m-0 flex list-disc flex-col gap-1 pl-5 text-danger-ink">
                    {job.safety.addresses.map((a) => (
                      <li key={a.address}>
                        {a.address}
                        {a.description ? `: ${a.description}` : ""}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </>
            ) : (
              <p className="m-0 text-sm text-muted">None on this detail.</p>
            )}
            {!closed ? <SafetyEditor jobId={job.id} notes={job.safety?.notes ?? ""} addresses={job.safety?.addresses.map((a) => ({ address: a.address, description: a.description ?? "", lat: a.lat, lng: a.lng, source: a.source })) ?? []} /> : null}
          </Card>

          <Card>
            <CardTitle>Staffing</CardTitle>
            <StaffingGrid positions={admin.positions.map((p) => ({ id: p.id, name: p.name, filled: p.filled, requested: p.count, backups: p.backups }))} />
            {admin.roster.length === 0 ? <p className="m-0 text-sm text-muted">Nobody has signed up yet.</p> : null}
            {history.length ? (
              <>
                <h3 className="m-0 text-sm font-semibold text-muted">Sign-up history, oldest first</h3>
                <ul className="m-0 flex list-none flex-col divide-y divide-divider p-0" aria-label="Sign-up history">
                  {history.map((item) => {
                    if (item.event) {
                      const e = item.event;
                      return (
                        <li key={`event-${e.at.getTime()}-${e.kind}`} data-testid="detail-event" className="flex items-start gap-2 py-2.5 text-sm">
                          <Chip tone={e.kind === "canceled" ? "danger" : "success"}>{e.kind === "canceled" ? "Detail canceled" : "Detail reactivated"}</Chip>
                          <span className="max-w-[70ch] min-w-0">{eventLine(e)}</span>
                        </li>
                      );
                    }
                    const r = item.row;
                    return (
                    <li key={r.assignmentId} data-active={r.active} className="flex flex-col gap-2 py-2.5 md:flex-row md:items-start md:justify-between">
                      <span className="flex min-w-0 flex-col gap-1">
                        <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                          <span className={r.active ? "font-semibold" : "font-medium text-muted line-through decoration-1"}>
                            {r.name}
                            {r.isIncidentCommander ? " (Incident Commander)" : ""}
                          </span>
                          <Chip tone={!r.active ? "neutral" : r.status === "backup" || r.status === "pending_short" ? "warning" : r.status === "paid" ? "success" : "info"}>
                            {r.label}
                            {r.active && r.backupPosition ? ` #${r.backupPosition}` : ""}
                          </Chip>
                        </span>
                        <span className="text-sm text-muted">
                          {r.position}
                          {r.overrideReason ? `. Override: ${r.overrideReason}` : ""}
                        </span>
                        {r.ended ? (
                          <span className="max-w-[70ch] text-sm text-muted">
                            {r.ended.by ? `By ${r.ended.by}, ` : ""}
                            {dateTime(r.ended.at)}
                            {r.ended.reason ? `: ${r.ended.reason}` : ""}
                          </span>
                        ) : null}
                      </span>
                      {!closed && r.active ? <RosterRowActions assignmentId={r.assignmentId} jobId={job.id} userId={r.userId} name={r.name} status={r.status} started={started} canNameIc={job.opsPlanRequired && !icPosition} /> : null}
                    </li>
                    );
                  })}
                </ul>
              </>
            ) : null}
            {!closed && job.state !== "requested" ? <AssignForm positions={admin.positions.map((p) => ({ id: p.id, name: p.name, open: Math.max(0, p.count - p.filled) }))} people={data.people} /> : null}
          </Card>

          {ops ? (
            <Card>
              <h2 id="ops-plan" className="m-0 scroll-mt-6 text-title font-semibold md:text-base">
                Ops plan
              </h2>
              {ops.status !== "agreed" && ops.status !== "submitted" && ops.dueAt && ops.dueAt.getTime() < now.getTime() ? <Chip tone="danger">Overdue</Chip> : null}
              <p className="m-0 text-sm text-muted">
                {ops.status === "agreed" ? "Agreed." : ops.status === "denied" ? "Denied. The Incident Commander must submit a new version." : ops.status === "submitted" ? "Submitted, waiting for review." : "Not submitted yet."}
                {ops.dueAt ? ` Due ${dateLabel(ops.dueAt)} at ${clock(ops.dueAt)}.` : ""}
                {ops.incidentCommanderId ? "" : " No Incident Commander yet."}
              </p>
              {ops.versions.length ? (
                <ul className="m-0 flex list-none flex-col divide-y divide-divider p-0">
                  {[...ops.versions].reverse().map((v, i) => {
                    const superseded = v.decision === "pending" && v.id !== latest?.id;
                    return (
                      <li key={v.id} className="flex flex-wrap items-center justify-between gap-2 py-2.5">
                        <span className="flex flex-col">
                          <span className="font-medium">
                            Version {ops.versions.length - i}: {v.filename}
                          </span>
                          <span className="text-xs text-muted">
                            Submitted {dateTime(v.submittedAt)}
                            {v.comments ? `. Reviewer: ${v.comments}` : ""}
                          </span>
                        </span>
                        <span className="flex items-center gap-2">
                          <Chip tone={superseded ? "neutral" : v.decision === "agreed" ? "success" : v.decision === "denied" ? "danger" : "warning"}>
                            {superseded ? "Superseded" : v.decision === "agreed" ? "Agreed" : v.decision === "denied" ? "Denied" : "Pending"}
                          </Chip>
                          <a href={`/api/v1/ops-plans/versions/${v.id}/file`} className="inline-flex min-h-11 items-center gap-1 text-sm font-semibold" aria-label={`Download ${v.filename}`}>
                            <Icon name="download" size={16} />
                            Download
                          </a>
                        </span>
                      </li>
                    );
                  })}
                </ul>
              ) : null}
              {data.canReview && ops.opsPlanId && latest ? <OpsPlanReview opsPlanId={ops.opsPlanId} versionId={latest.id} /> : ops.status === "submitted" ? <p className="m-0 text-xs text-muted">Only a reviewer named in settings, other than the submitter and the Incident Commander, can review it.</p> : null}
            </Card>
          ) : null}

          <Card>
            <h2 id="attachments" className="m-0 scroll-mt-6 text-title font-semibold md:text-base">
              Attachments
            </h2>
            {job.attachments.length === 0 ? (
              <p className="m-0 text-sm text-muted">
                None on this detail.{" "}
                {job.contractStatus === "missing" ? (
                  <>
                    No vendor contract is on file either. Attach one to this detail below, or <Link href={`/coordinate/vendors/${job.vendorId}#documents`}>add one on the vendor record</Link>.
                  </>
                ) : (
                  "The vendor's contract on file covers it."
                )}
              </p>
            ) : (
              <ul className="m-0 flex list-none flex-col gap-1 p-0">
                {job.attachments.map((a) => (
                  <li key={a.id} className="flex flex-wrap items-center gap-2">
                    {a.url ? (
                      <a href={a.url} rel="noreferrer noopener" target="_blank">
                        {a.label}
                      </a>
                    ) : a.fileId ? (
                      <a href={`/api/v1/jobs/${job.id}/attachments/${a.id}/file`} className="inline-flex items-center gap-1" download>
                        {a.label}
                        <span className="sr-only">, download</span>
                        <Icon name="download" size={16} />
                      </a>
                    ) : (
                      <span>{a.label}</span>
                    )}
                    {a.isContract ? <Chip>Contract</Chip> : null}
                  </li>
                ))}
              </ul>
            )}
            {job.attachments.length > 0 && job.contractStatus === "missing" ? (
              <p className="m-0 text-sm text-muted">
                None of these is a contract, and no vendor contract is on file. Attach one below, or <Link href={`/coordinate/vendors/${job.vendorId}#documents`}>add one on the vendor record</Link>.
              </p>
            ) : null}
            <AttachContract key={job.contractStatus ?? "none"} jobId={job.id} missing={job.contractStatus === "missing"} maxBytes={MAX_FILE_BYTES} />
          </Card>

          <Card>
            <CardTitle>Deputy notes</CardTitle>
            {data.notes.length === 0 ? (
              <p className="m-0 text-sm text-muted">No approved notes for this vendor or place.</p>
            ) : (
              <ul className="m-0 flex list-none flex-col gap-3 p-0">
                {data.notes.map((n, i) => (
                  <li key={i} className="flex flex-col gap-0.5">
                    <p className="m-0 max-w-[70ch]">{n.body}</p>
                    <span className="text-xs text-muted">
                      {n.authorName}, {dateLabel(n.writtenAt)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card>
            <CardTitle>Activity</CardTitle>
            {data.activity.length === 0 ? (
              <p className="m-0 text-sm text-muted">Nothing yet.</p>
            ) : (
              <ul className="m-0 flex list-none flex-col gap-1.5 p-0 text-sm">
                {data.activity.map((a) => (
                  <li key={a.id}>{a.event ? eventLine(a.event) : <><span className="text-muted">{dateTime(a.at)}:</span> {a.text}</>}</li>
                ))}
              </ul>
            )}
          </Card>
        </div>

        <div className="flex flex-col gap-4.5 md:col-start-2 md:row-start-2">
          {job.state !== "requested" && job.state !== "declined" ? (
            <Card>
              <CardTitle>Copy to other dates</CardTitle>
              <CopyDetail jobId={job.id} today={agencyDayKey(now)} weekStartsOn={data.options.weekStartsOn} />
            </Card>
          ) : null}
          {!closed && job.state !== "requested" ? (
            <Card>
              <CardTitle>Repeat this detail</CardTitle>
              <p className="m-0 text-sm text-muted">Adds later dates to {admin.seriesCount > 1 ? "this series" : "a new series that starts with this detail"}.</p>
              <RepeatDetail jobId={job.id} weekday={new Date(`${agencyDayKey(job.startAt)}T12:00:00Z`).getUTCDay()} dayOfMonth={agencyDateParts(job.startAt).day} />
            </Card>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/** A vendor's stored change, in words. */
function describePatch(patch: unknown): string {
  if (!patch || typeof patch !== "object") return "a change";
  const keys = Object.keys(patch as Record<string, unknown>);
  const words: Record<string, string> = { startAt: "start time", endAt: "end time", positions: "headcount", description: "description", title: "title", locationId: "location" };
  const named = keys.map((k) => words[k]).filter(Boolean);
  return named.length ? `new ${named.join(", ")}` : "a change";
}
