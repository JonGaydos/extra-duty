import Link from "next/link";
import type { DetailEvent } from "@/domain/assignments/history";
import type { JobDisplayStatus } from "@/domain/jobs/status";
import { editBlockReason } from "@/domain/jobs/bulk-edit";
import { MAX_FILE_BYTES } from "@/domain/files/files";
import { agencyDateParts, agencyDayKey } from "@/domain/time/agency-time";
import { Card, CardTitle } from "@/ui/components/Card";
import { Chip } from "@/ui/components/Chip";
import { SiteContact } from "@/ui/components/ContactList";
import { MapsLink } from "@/ui/components/MapsLink";
import { Notice } from "@/ui/components/Notice";
import { PayLabel, dollars } from "@/ui/components/PayLabel";
import { StaffingGrid } from "@/ui/components/StaffingGrid";
import { Icon } from "@/ui/icons";
import { keyedByContent } from "@/lib/list-keys";
import { clock, dateLabel, dateTime, plural, timeRange, whenText } from "../../../_personnel/format";
import { DetailInvoiceHold } from "../../../coordinate/_coordinator/ChoiceSave";
import type { DetailWire } from "../../../coordinate/_coordinator/detail-input";
import { QuickEdit } from "../../../coordinate/_coordinator/EditPanel";
import { RateOverrideNote } from "../../../coordinate/_coordinator/rate-override";
import { Facts } from "../../../coordinate/_coordinator/ui";
import {
  AssignForm,
  AttachContract,
  CancelDetail,
  ChangeDecision,
  CopyDetail,
  EditDetail,
  HoldRelease,
  OpsPlanReview,
  ReactivateDetail,
  RepeatDetail,
  RequestDecision,
  RosterRowActions,
  SafetyEditor,
  WaiveLateCancel,
} from "./DetailActions";
import type { DetailData } from "./load";

/** The loaded detail and what the page works out from it once, shared by every section. */
export type DetailContext = {
  d: DetailData;
  now: Date;
  started: boolean;
  closed: boolean;
  releaseStatus: string;
  initial: DetailWire;
};

type Job = DetailData["job"];
type RosterRow = DetailData["admin"]["roster"][number];
type OpsPlan = NonNullable<DetailData["ops"]>;
type OpsVersion = OpsPlan["versions"][number];
type Attachment = Job["attachments"][number];

/** "Canceled by Pat Lee on Nov 24, 2026 at 3:00 PM: Wrong date", for staff. */
export const eventLine = (e: DetailEvent) => {
  const reason = e.reason ? `: ${e.reason}` : "";
  return `${e.kind === "canceled" ? "Canceled" : "Reactivated"} by ${e.by ?? "the system"} on ${dateTime(e.at)}${reason}`;
};

/** The statuses a detail takes once it has ended. */
const ENDED: Partial<Record<JobDisplayStatus, { tone: "attention" | "info" | "success" | "neutral"; text: string }>> = {
  ready_to_bill: { tone: "attention", text: "Ready to bill" },
  billed: { tone: "info", text: "Billed" },
  closed: { tone: "success", text: "Closed" },
};

const released = (job: Job, now: Date) => !!job.releaseAt && job.releaseAt.getTime() <= now.getTime();

/** When the detail opens for sign-up, or why it does not. */
export function releaseStatusText(job: Job, now: Date): string {
  if (job.held) return "Held: off the open lists and no new sign-ups. People already on it keep their spots.";
  if (job.state === "requested" || !job.releaseAt) return "After approval";
  return released(job, now) ? `Open for sign-up since ${dateTime(job.releaseAt)}` : `Opens ${dateTime(job.releaseAt)}`;
}

/** The one chip for where the detail is: a request, declined, canceled, ended, started, released or not. */
function StateChip({ c }: Readonly<{ c: DetailContext }>) {
  const { job } = c.d;
  const ended = ENDED[c.d.status];
  if (job.state === "requested") return <Chip tone="warning">Vendor request</Chip>;
  if (job.state === "declined") return <Chip>Declined</Chip>;
  if (job.state === "canceled") return <Chip tone="danger">Canceled</Chip>;
  if (ended) return <Chip tone={ended.tone}>{ended.text}</Chip>;
  if (c.started) return <Chip>Started</Chip>;
  if (job.held) return null;
  return released(job, c.now) ? <Chip tone="success">Released</Chip> : <Chip tone="info">Not released</Chip>;
}

/** The detail's number, state and warning chips, its title, vendor and place. */
export function DetailHeader({ c }: Readonly<{ c: DetailContext }>) {
  const { job, admin } = c.d;
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap gap-1.5">
        <Chip>Detail #{job.number}</Chip>
        <StateChip c={c} />
        {job.held ? <Chip tone="warning">Held</Chip> : null}
        {admin.locked ? <Chip tone="danger">Locked: vendor on payment hold</Chip> : null}
        {admin.seriesCount > 1 ? <Chip>Series of {admin.seriesCount}</Chip> : null}
        {job.contractStatus === "missing" ? <Chip tone="warning">No contract</Chip> : null}
        {c.d.rateOutside && !c.d.rateOverride ? <Chip tone="warning">Rate outside the agency range</Chip> : null}
      </div>
      <h1 className="m-0 text-2xl font-bold md:text-3xl">{job.title}</h1>
      <p className="m-0 text-muted">
        <Link href={`/coordinate/vendors/${job.vendorId}`}>{admin.vendorName}</Link>
        {admin.locationName ? `, ${admin.locationName}` : ""}
      </p>
    </div>
  );
}

/** Quick edit of the rate, times, description and positions, closed once the detail has started. */
export function QuickEditCard({ c }: Readonly<{ c: DetailContext }>) {
  const { job, admin, options } = c.d;
  const { initial } = c;
  const quickBlock = editBlockReason(job, c.now);
  return (
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
          types={options.positionTypes}
          defaultTypeId={options.defaultPositionTypeId ?? options.positionTypes[0]?.id ?? ""}
          seriesLater={admin.laterInSeries}
          started={c.started}
          range={options.rateRange}
          approved={!!c.d.rateOverride}
        />
      )}
    </Card>
  );
}

/** Edit, hold and release, the invoice hold, reactivate, waive late-cancel pay and cancel. */
export function ManageCard({ c }: Readonly<{ c: DetailContext }>) {
  const { job, admin } = c.d;
  const { closed, started } = c;
  const live = job.state !== "requested" && job.state !== "declined";
  return (
    <Card>
      <CardTitle>Manage</CardTitle>
      {!closed ? (
        <EditDetail jobId={job.id} initial={c.initial} date={agencyDayKey(job.startAt)} options={c.d.options} seriesLater={admin.laterInSeries} started={started} approved={!!c.d.rateOverride} />
      ) : null}
      {!closed && job.state !== "requested" && !started ? (
        <HoldRelease jobId={job.id} held={job.held} opensLater={!!job.releaseAt && job.releaseAt.getTime() > c.now.getTime()} seriesLater={admin.laterInSeries} status={c.releaseStatus} />
      ) : null}
      {live ? <DetailInvoiceHold jobId={job.id} current={job.waitForAllDeputies} agency={c.d.agencyWait} /> : null}
      {c.d.reactivation ? <ReactivateDetail jobId={job.id} preview={c.d.reactivation} /> : null}
      {job.state === "canceled" && admin.lateCanceled > 0 && !job.lateCancelWaivedReason ? (
        <>
          <Notice tone="warning">{plural(admin.lateCanceled, "person is", "people are")} paid for this late cancellation.</Notice>
          <WaiveLateCancel jobId={job.id} />
        </>
      ) : null}
      {!closed && !started ? <CancelDetail jobId={job.id} locked={admin.locked} latePayDefault={admin.latePay} /> : null}
      {!closed && started && admin.locked ? <CancelDetail jobId={job.id} locked latePayDefault={admin.latePay} /> : null}
    </Card>
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

/** A vendor's request to approve or decline, and the changes a vendor asked for. */
export function VendorAsks({ c }: Readonly<{ c: DetailContext }>) {
  const { job, admin } = c.d;
  return (
    <>
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
          {admin.pendingChanges.map((ch) => (
            <div key={ch.id} className="flex flex-col gap-2">
              <p className="m-0 text-sm text-warning-ink">
                Asked {dateTime(ch.requestedAt)}: {describePatch(ch.patch)}
              </p>
              <ChangeDecision requestId={ch.id} jobId={job.id} />
            </div>
          ))}
        </Card>
      ) : null}
    </>
  );
}

/** "6:00 PM to 10:00 PM, shorter shifts allowed" for a flexible detail. */
function flexFacts(job: Job): Array<[string, string]> {
  if (!job.flexEarliestStartAt || !job.flexLatestEndAt) return [];
  const shorter = job.flexAllowShorter ? ", shorter shifts allowed" : "";
  return [["Flexible", `${timeRange(job.flexEarliestStartAt, job.flexLatestEndAt)}${shorter}`]];
}

/** When, pay, type, place, site contact and release, then the description, notes and cancel reason. */
export function FactsCard({ c }: Readonly<{ c: DetailContext }>) {
  const { job, admin } = c.d;
  return (
    <Card>
      <Facts
        items={[
          ["When", whenText(job.startAt, job.endAt, c.now)],
          ...flexFacts(job),
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
              {c.d.rateOverride ? <RateOverrideNote override={c.d.rateOverride} /> : null}
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
          ["Release", c.releaseStatus],
        ]}
      />
      {job.description ? <p className="m-0 max-w-[70ch] whitespace-pre-line">{job.description}</p> : null}
      {job.notes ? <p className="m-0 max-w-[70ch] text-sm whitespace-pre-line text-muted">Notes for deputies: {job.notes}</p> : null}
      {job.state === "canceled" ? <Notice tone="danger">Canceled{job.cancelReason ? `: ${job.cancelReason}` : "."}</Notice> : null}
    </Card>
  );
}

/** Officer safety notes and addresses, with the editor while the detail is open. */
export function SafetyCard({ c }: Readonly<{ c: DetailContext }>) {
  const { job } = c.d;
  return (
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
      {!c.closed ? <SafetyEditor jobId={job.id} notes={job.safety?.notes ?? ""} addresses={job.safety?.addresses.map((a) => ({ address: a.address, description: a.description ?? "", lat: a.lat, lng: a.lng, source: a.source })) ?? []} /> : null}
    </Card>
  );
}

/** A roster row's chip: struck through when ended, warning while waiting, success when paid. */
function rosterTone(r: RosterRow): "neutral" | "warning" | "success" | "info" {
  if (!r.active) return "neutral";
  if (r.status === "backup" || r.status === "pending_short") return "warning";
  return r.status === "paid" ? "success" : "info";
}

/** A cancel or reactivation of the whole detail, in the sign-up history. */
function HistoryEvent({ e }: Readonly<{ e: DetailEvent }>) {
  return (
    <li data-testid="detail-event" className="flex items-start gap-2 py-2.5 text-sm">
      <Chip tone={e.kind === "canceled" ? "danger" : "success"}>{e.kind === "canceled" ? "Detail canceled" : "Detail reactivated"}</Chip>
      <span className="max-w-[70ch] min-w-0">{eventLine(e)}</span>
    </li>
  );
}

/** One sign-up in the history: who, its status, the position and how it ended, with its actions while open. */
function HistoryRow({ r, c, canNameIc }: Readonly<{ r: RosterRow; c: DetailContext; canNameIc: boolean }>) {
  return (
    <li data-active={r.active} className="flex flex-col gap-2 py-2.5 md:flex-row md:items-start md:justify-between">
      <span className="flex min-w-0 flex-col gap-1">
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className={r.active ? "font-semibold" : "font-medium text-muted line-through decoration-1"}>
            {r.name}
            {r.isIncidentCommander ? " (Incident Commander)" : ""}
          </span>
          <Chip tone={rosterTone(r)}>
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
      {!c.closed && r.active ? <RosterRowActions assignmentId={r.assignmentId} jobId={c.d.job.id} userId={r.userId} name={r.name} status={r.status} started={c.started} canNameIc={canNameIc} /> : null}
    </li>
  );
}

type HistoryItem = { at: number; row: RosterRow; event?: undefined } | { at: number; event: DetailEvent; row?: undefined };

/** The staffing grid, the sign-up history (with the detail's cancels and reactivations) and Assign. */
export function StaffingCard({ c }: Readonly<{ c: DetailContext }>) {
  const { job, admin } = c.d;
  const icPosition = admin.positions.some((p) => p.isIncidentCommander);
  // Sign-ups and the detail's cancels and reactivations, in the order they happened.
  const history: HistoryItem[] = [
    ...admin.roster.map((row) => ({ at: row.requestedAt.getTime(), row })),
    ...admin.events.map((event) => ({ at: event.at.getTime(), event })),
  ].sort((a, b) => a.at - b.at);
  return (
    <Card>
      <CardTitle>Staffing</CardTitle>
      <StaffingGrid positions={admin.positions.map((p) => ({ id: p.id, name: p.name, filled: p.filled, requested: p.count, backups: p.backups }))} />
      {admin.roster.length === 0 ? <p className="m-0 text-sm text-muted">Nobody has signed up yet.</p> : null}
      {history.length ? (
        <>
          <h3 className="m-0 text-sm font-semibold text-muted">Sign-up history, oldest first</h3>
          <ul className="m-0 flex list-none flex-col divide-y divide-divider p-0" aria-label="Sign-up history">
            {history.map((item) =>
              item.event ? (
                <HistoryEvent key={`event-${item.event.at.getTime()}-${item.event.kind}`} e={item.event} />
              ) : (
                <HistoryRow key={item.row.assignmentId} r={item.row} c={c} canNameIc={job.opsPlanRequired && !icPosition} />
              ),
            )}
          </ul>
        </>
      ) : null}
      {!c.closed && job.state !== "requested" ? <AssignForm positions={admin.positions.map((p) => ({ id: p.id, name: p.name, open: Math.max(0, p.count - p.filled) }))} people={c.d.people} /> : null}
    </Card>
  );
}

const OPS_STATUS_TEXT: Record<string, string> = {
  agreed: "Agreed.",
  denied: "Denied. The Incident Commander must submit a new version.",
  submitted: "Submitted, waiting for review.",
};

const VERSION_CHIP: Record<string, { tone: "success" | "danger" | "warning"; text: string }> = {
  agreed: { tone: "success", text: "Agreed" },
  denied: { tone: "danger", text: "Denied" },
};
const PENDING_CHIP = { tone: "warning", text: "Pending" } as const;
const SUPERSEDED_CHIP = { tone: "neutral", text: "Superseded" } as const;

/** One ops plan version, newest first: its file, the reviewer's comments and its decision. */
function OpsVersionRow({ v, number, superseded }: Readonly<{ v: OpsVersion; number: number; superseded: boolean }>) {
  const chip = superseded ? SUPERSEDED_CHIP : (VERSION_CHIP[v.decision] ?? PENDING_CHIP);
  return (
    <li className="flex flex-wrap items-center justify-between gap-2 py-2.5">
      <span className="flex flex-col">
        <span className="font-medium">
          Version {number}: {v.filename}
        </span>
        <span className="text-xs text-muted">
          Submitted {dateTime(v.submittedAt)}
          {v.comments ? `. Reviewer: ${v.comments}` : ""}
        </span>
      </span>
      <span className="flex items-center gap-2">
        <Chip tone={chip.tone}>{chip.text}</Chip>
        <a href={`/api/v1/ops-plans/versions/${v.id}/file`} className="inline-flex min-h-11 items-center gap-1 text-sm font-semibold" aria-label={`Download ${v.filename}`}>
          <Icon name="download" size={16} />
          Download
        </a>
      </span>
    </li>
  );
}

/** Review for a named reviewer, or who may review a submitted plan. */
function OpsReview({ c, ops }: Readonly<{ c: DetailContext; ops: OpsPlan }>) {
  const latest = ops.versions.at(-1);
  if (c.d.canReview && ops.opsPlanId && latest) return <OpsPlanReview opsPlanId={ops.opsPlanId} versionId={latest.id} />;
  if (ops.status === "submitted") return <p className="m-0 text-xs text-muted">Only a reviewer named in settings, other than the submitter and the Incident Commander, can review it.</p>;
  return null;
}

/** The ops plan: whether it is overdue, its status and due time, every version, and review. */
export function OpsPlanCard({ c, ops }: Readonly<{ c: DetailContext; ops: OpsPlan }>) {
  const latest = ops.versions.at(-1);
  return (
    <Card>
      <h2 id="ops-plan" className="m-0 scroll-mt-6 text-title font-semibold md:text-base">
        Ops plan
      </h2>
      {ops.status !== "agreed" && ops.status !== "submitted" && ops.dueAt && ops.dueAt.getTime() < c.now.getTime() ? <Chip tone="danger">Overdue</Chip> : null}
      <p className="m-0 text-sm text-muted">
        {OPS_STATUS_TEXT[ops.status] ?? "Not submitted yet."}
        {ops.dueAt ? ` Due ${dateLabel(ops.dueAt)} at ${clock(ops.dueAt)}.` : ""}
        {ops.incidentCommanderId ? "" : " No Incident Commander yet."}
      </p>
      {ops.versions.length ? (
        <ul className="m-0 flex list-none flex-col divide-y divide-divider p-0">
          {[...ops.versions].reverse().map((v, i) => (
            <OpsVersionRow key={v.id} v={v} number={ops.versions.length - i} superseded={v.decision === "pending" && v.id !== latest?.id} />
          ))}
        </ul>
      ) : null}
      <OpsReview c={c} ops={ops} />
    </Card>
  );
}

/** An attachment: a link, a file to download, or its label alone. */
function AttachmentLabel({ a, jobId }: Readonly<{ a: Attachment; jobId: string }>) {
  if (a.url)
    return (
      <a href={a.url} rel="noreferrer noopener" target="_blank">
        {a.label}
      </a>
    );
  if (a.fileId)
    return (
      <a href={`/api/v1/jobs/${jobId}/attachments/${a.id}/file`} className="inline-flex items-center gap-1" download>
        {a.label}
        <span className="sr-only">, download</span>
        <Icon name="download" size={16} />
      </a>
    );
  return <span>{a.label}</span>;
}

/** The detail's attachments, whether a contract covers it, and Attach. */
export function AttachmentsCard({ c }: Readonly<{ c: DetailContext }>) {
  const { job } = c.d;
  return (
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
              <AttachmentLabel a={a} jobId={job.id} />
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
  );
}

/** Approved deputy notes for the vendor or place, and the detail's recent activity. */
export function NotesAndActivity({ c }: Readonly<{ c: DetailContext }>) {
  return (
    <>
      <Card>
        <CardTitle>Deputy notes</CardTitle>
        {c.d.notes.length === 0 ? (
          <p className="m-0 text-sm text-muted">No approved notes for this vendor or place.</p>
        ) : (
          <ul className="m-0 flex list-none flex-col gap-3 p-0">
            {keyedByContent(c.d.notes).map(({ key, item: n }) => (
              <li key={key} className="flex flex-col gap-0.5">
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
        {c.d.activity.length === 0 ? (
          <p className="m-0 text-sm text-muted">Nothing yet.</p>
        ) : (
          <ul className="m-0 flex list-none flex-col gap-1.5 p-0 text-sm">
            {c.d.activity.map((a) => (
              <li key={a.id}>{a.event ? eventLine(a.event) : <><span className="text-muted">{dateTime(a.at)}:</span> {a.text}</>}</li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}

/** Copy to other dates and Repeat, beside the detail on desktop. */
export function CopyAndRepeat({ c }: Readonly<{ c: DetailContext }>) {
  const { job, admin } = c.d;
  return (
    <div className="flex flex-col gap-4.5 md:col-start-2 md:row-start-2">
      {job.state !== "requested" && job.state !== "declined" ? (
        <Card>
          <CardTitle>Copy to other dates</CardTitle>
          <CopyDetail jobId={job.id} today={agencyDayKey(c.now)} weekStartsOn={c.d.options.weekStartsOn} />
        </Card>
      ) : null}
      {!c.closed && job.state !== "requested" ? (
        <Card>
          <CardTitle>Repeat this detail</CardTitle>
          <p className="m-0 text-sm text-muted">Adds later dates to {admin.seriesCount > 1 ? "this series" : "a new series that starts with this detail"}.</p>
          <RepeatDetail jobId={job.id} weekday={new Date(`${agencyDayKey(job.startAt)}T12:00:00Z`).getUTCDay()} dayOfMonth={agencyDateParts(job.startAt).day} />
        </Card>
      ) : null}
    </div>
  );
}
