import { DEPUTY_NOTE_MAX } from "@/domain/deputy-notes/deputy-notes";
import { Card, CardTitle } from "@/ui/components/Card";
import { Chip } from "@/ui/components/Chip";
import { MapsLink } from "@/ui/components/MapsLink";
import { SiteContact } from "@/ui/components/ContactList";
import { PayLabel, dollars } from "@/ui/components/PayLabel";
import { StaffingGrid } from "@/ui/components/StaffingGrid";
import { Icon } from "@/ui/icons";
import { keyedByContent } from "@/lib/list-keys";
import { clock, dateLabel, dayLabel, hoursText, timeRange } from "../../_personnel/format";
import { jobChips } from "../../_personnel/JobRow";
import { DeputyNoteForm } from "./DeputyNoteForm";
import type { JobPageData } from "./load";
import { OpsPlanUpload } from "./OpsPlanUpload";
import { SafetyMap } from "./SafetyMap";
import { WatchSwitch } from "./WatchSwitch";

type JobCard = JobPageData["card"];
type Job = JobPageData["job"];
type Safety = NonNullable<Job["safety"]>;
type OpsPlan = NonNullable<JobPageData["ops"]>;
type OpsVersion = OpsPlan["versions"][number];

const ROLE: Record<string, string> = { admin: "admin", coordinator: "coordinator", personnel: "deputy", vendor: "vendor" };

function stamp(by: string | null, role: string | null, at: Date | null, verb: string): string | null {
  if (!at) return null;
  const roleText = role ? `, ${ROLE[role] ?? role}` : "";
  return `${verb} by ${by ?? "someone"}${roleText}, ${dateLabel(at)}.`;
}

/** The chips, title, when, pay, meeting place, site contact and the watch switch. */
export function FactsCard({ d, staff, showWatch }: Readonly<{ d: JobPageData; staff: boolean; showWatch: boolean }>) {
  const { job, card } = d;
  const address = [card.locationName, card.address].filter(Boolean).join(", ");
  return (
    <Card>
      <div className="flex flex-wrap items-center gap-1.5">
        {jobChips(card).map((c) => (
          <Chip key={c.text} tone={c.tone}>
            {c.text}
          </Chip>
        ))}
        <Chip>#{card.number}</Chip>
      </div>
      <div className="flex flex-col gap-1">
        <h1 className="m-0 text-2xl font-bold md:text-3xl">{job.title}</h1>
        <p className="m-0 text-muted">
          {card.vendorName}
          {card.locationName ? `, ${card.locationName}` : ""}
        </p>
      </div>
      <dl className="m-0 grid gap-3 border-t border-divider pt-3 sm:grid-cols-2">
        <div className="flex flex-col gap-0.5">
          <dt className="text-xs font-semibold text-muted">When</dt>
          <dd className="m-0 flex flex-col">
            <b>{dayLabel(job.startAt)}</b>
            <span>{timeRange(job.startAt, job.endAt)}</span>
            {card.flex ? <span className="text-sm text-muted">Allowed {timeRange(card.flex.earliestStartAt, card.flex.latestEndAt)}</span> : null}
          </dd>
        </div>
        <div className="flex flex-col gap-0.5">
          <dt className="text-xs font-semibold text-muted">Pay</dt>
          <dd className="m-0 flex flex-col">
            <PayLabel variant="plain" totalCents={card.totalCents} rateCents={card.rateCents} upTo={{ totalCents: card.maxTotalCents, rateCents: card.maxRateCents }} />
            <span className="text-sm text-muted">For {hoursText(card.minutes)} as scheduled</span>
            <PositionRates card={card} />
          </dd>
        </div>
        {address ? (
          <div className="flex flex-col gap-0.5 sm:col-span-2">
            <dt className="text-xs font-semibold text-muted">Meet at</dt>
            <dd className="m-0 flex flex-col">
              <span>{address}</span>
              {card.address || card.lat !== null ? <MapsLink address={card.address} lat={card.lat} lng={card.lng} /> : null}
            </dd>
          </div>
        ) : null}
        {job.contactName || job.contactPhone ? (
          <div className="flex flex-col gap-0.5 sm:col-span-2">
            <dt className="text-xs font-semibold text-muted">Contact on site</dt>
            <dd className="m-0">
              <SiteContact name={job.contactName} phone={job.contactPhone} staff={staff} />
            </dd>
          </div>
        ) : null}
      </dl>
      {showWatch ? (
        <div className="border-t border-divider pt-3">
          <WatchSwitch jobId={job.id} watching={card.watching} />
        </div>
      ) : null}
    </Card>
  );
}

/** Positions that pay a different rate, for someone not on the detail. */
function PositionRates({ card }: Readonly<{ card: JobCard }>) {
  if (card.mine || card.maxRateCents <= card.rateCents) return null;
  return card.positions
    .filter((p) => p.rateCents !== card.rateCents)
    .map((p) => (
      <span key={p.id} className="text-sm text-muted">
        {p.name}: {dollars(p.rateCents)}/hr
      </span>
    ));
}

/** Officer safety notes and addresses, each with who added or edited it and a map. */
export function SafetyCard({ safety, tileUrl, attribution }: Readonly<{ safety: Safety; tileUrl: string; attribution: string }>) {
  return (
    <Card tone="danger" aria-labelledby="safety-title">
      <h2 id="safety-title" className="m-0 flex items-center gap-2 text-title font-semibold text-danger-ink md:text-base">
        <Icon name="shield" size={20} />
        Officer safety
      </h2>
      {safety.notes?.trim() ? <p className="m-0 max-w-[70ch] whitespace-pre-line text-danger-ink">{safety.notes}</p> : null}
      <p className="m-0 text-xs text-danger-ink">
        {[stamp(safety.addedByName, safety.addedByRole, safety.addedAt, "Added"), stamp(safety.editedByName, safety.editedByRole, safety.editedAt, "Edited")]
          .filter(Boolean)
          .join(" ")}
      </p>
      {safety.addresses.length > 0 ? (
        <ul className="m-0 flex list-none flex-col gap-3 p-0">
          {safety.addresses.map((a) => (
            <li key={a.id} className="flex flex-col gap-1 rounded-md bg-surface p-3 text-ink">
              <b>{a.address}</b>
              {a.description ? <span>{a.description}</span> : null}
              <span className="text-xs text-muted">
                {[stamp(a.addedByName, a.addedByRole, a.addedAt, "Added"), stamp(a.editedByName, a.editedByRole, a.editedAt, "Edited")].filter(Boolean).join(" ")}
              </span>
              <MapsLink address={a.address} lat={a.lat} lng={a.lng} />
              {a.lat !== null && a.lng !== null ? (
                <SafetyMap tileUrl={tileUrl} attribution={attribution} pin={{ id: a.id, lat: a.lat, lng: a.lng, label: "Safety", name: `Officer safety address: ${a.address}`, tone: "safety" }} />
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </Card>
  );
}

/** The description and notes for deputies, when there are any. */
export function AboutCard({ job }: Readonly<{ job: Job }>) {
  if (!job.description?.trim() && !job.notes?.trim()) return null;
  return (
    <Card>
      <CardTitle>About</CardTitle>
      {job.description?.trim() ? <p className="m-0 max-w-[70ch] whitespace-pre-line">{job.description}</p> : null}
      {job.notes?.trim() ? <p className="m-0 max-w-[70ch] whitespace-pre-line text-muted">{job.notes}</p> : null}
    </Card>
  );
}

/** Filled over requested, and the staffing grid. */
export function StaffingCard({ card }: Readonly<{ card: JobCard }>) {
  return (
    <Card>
      <div className="flex items-center gap-2">
        <CardTitle>Staffing</CardTitle>
        <span className="rounded-full bg-accent-soft px-2 text-xs leading-5.5 font-semibold text-link" data-numeric>
          {card.positions.reduce((n, p) => n + Math.min(p.filled, p.count), 0)} / {card.positions.reduce((n, p) => n + p.count, 0)}
        </span>
      </div>
      <StaffingGrid positions={card.positions.map((p) => ({ id: p.id, name: p.name, filled: p.filled, requested: p.count, backups: p.backups }))} />
    </Card>
  );
}

const OPS_STATUS_TEXT: Record<string, string> = {
  agreed: "Agreed.",
  denied: "Denied. A new version is needed.",
  submitted: "Submitted, waiting for review.",
};

const VERSION_CHIP: Record<string, { tone: "success" | "danger" | "warning"; text: string }> = {
  agreed: { tone: "success", text: "Agreed" },
  denied: { tone: "danger", text: "Denied" },
};
const PENDING_CHIP = { tone: "warning", text: "Pending" } as const;
const SUPERSEDED_CHIP = { tone: "neutral", text: "Superseded" } as const;

/** One ops plan version, newest first: its file, when it was submitted and its decision. */
function OpsVersionRow({ v, superseded }: Readonly<{ v: OpsVersion; superseded: boolean }>) {
  const chip = superseded ? SUPERSEDED_CHIP : (VERSION_CHIP[v.decision] ?? PENDING_CHIP);
  return (
    <li className="flex flex-wrap items-center justify-between gap-2 py-2.5">
      <span className="flex flex-col">
        <span className="font-medium">{v.filename}</span>
        <span className="text-xs text-muted">Submitted {dateLabel(v.submittedAt)}</span>
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

/** The ops plan's status and due time, every version, and the upload for the Incident Commander. */
export function OpsPlanCard({ ops, job, userId }: Readonly<{ ops: OpsPlan; job: Job; userId: string }>) {
  const latestVersion = ops.versions.at(-1);
  return (
    <Card>
      <CardTitle>Ops plan</CardTitle>
      <p className="m-0 text-sm text-muted">
        {OPS_STATUS_TEXT[ops.status] ?? "Not submitted yet."}
        {ops.dueAt ? ` Due ${dateLabel(ops.dueAt)} at ${clock(ops.dueAt)}.` : ""}
      </p>
      {ops.versions.length > 0 ? (
        <ul className="m-0 flex list-none flex-col divide-y divide-divider p-0">
          {[...ops.versions].reverse().map((v) => (
            <OpsVersionRow key={v.id} v={v} superseded={v.decision === "pending" && v.id !== latestVersion?.id} />
          ))}
        </ul>
      ) : null}
      {ops.incidentCommanderId === userId && job.state !== "canceled" && job.state !== "declined" ? <OpsPlanUpload jobId={job.id} again={ops.versions.length > 0} /> : null}
    </Card>
  );
}

/** Approved notes from other deputies, and the note form once the person has worked the detail. */
export function NotesCard({ d, canNote }: Readonly<{ d: JobPageData; canNote: boolean }>) {
  return (
    <Card>
      <CardTitle>Deputy notes</CardTitle>
      {d.notes.length === 0 ? (
        <p className="m-0 text-sm text-muted">No notes from other deputies yet.</p>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-3 p-0">
          {keyedByContent(d.notes).map(({ key, item: n }) => (
            <li key={key} className="flex flex-col gap-1">
              <p className="m-0 max-w-[65ch] whitespace-pre-line">{n.body}</p>
              <span className="text-xs text-muted">
                {n.authorName}, {dateLabel(n.writtenAt)}
              </span>
            </li>
          ))}
        </ul>
      )}
      {canNote ? (
        <DeputyNoteForm jobId={d.job.id} hasLocation={d.job.locationId !== null} max={DEPUTY_NOTE_MAX} />
      ) : (
        <p className="m-0 text-xs text-muted">After you work this detail you can add a note for future deputies.</p>
      )}
    </Card>
  );
}

/** What has happened on the detail, newest first. */
export function ActivityCard({ activity }: Readonly<{ activity: JobPageData["activity"] }>) {
  return (
    <Card>
      <CardTitle>Activity</CardTitle>
      {activity.length === 0 ? (
        <p className="m-0 text-sm text-muted">No activity yet.</p>
      ) : (
        <ol className="m-0 flex list-none flex-col gap-2 p-0 text-sm">
          {activity.map((a) => (
            <li key={a.id} className="flex flex-col">
              <span>{a.text}</span>
              <span className="text-xs text-muted">
                {dateLabel(a.at)} at {clock(a.at)}
              </span>
            </li>
          ))}
        </ol>
      )}
    </Card>
  );
}
