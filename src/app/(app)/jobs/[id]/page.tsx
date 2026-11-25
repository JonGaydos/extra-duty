import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { withTx } from "@/ui/shell/request";
import { claimablePositionId } from "@/domain/assignments/backups";
import { eligibilityByPosition, type JobEligibility } from "@/domain/assignments/signup";
import { DEPUTY_NOTE_MAX, deputyNotesForJob } from "@/domain/deputy-notes/deputy-notes";
import { NotFoundError, type CheckResult } from "@/domain/errors";
import { shownChecks } from "@/domain/eligibility/eligibility";
import { getJob } from "@/domain/jobs/jobs";
import { getJobOpsPlan } from "@/domain/ops-plans/ops-plans";
import { capSummary, jobActivity, jobRoster, loadJobCards, myDetails, type CapUse } from "@/domain/personnel/views";
import { getSettings } from "@/domain/settings/settings";
import { Card, CardTitle } from "@/ui/components/Card";
import { Chip } from "@/ui/components/Chip";
import { MapsLink } from "@/ui/components/MapsLink";
import { SiteContact } from "@/ui/components/ContactList";
import { PayLabel, dollars } from "@/ui/components/PayLabel";
import { StaffingGrid } from "@/ui/components/StaffingGrid";
import { Table } from "@/ui/components/Table";
import { Icon } from "@/ui/icons";
import { loadShell } from "@/ui/shell/load-shell";
import { clock, dateLabel, dayLabel, hoursText, timeRange, wholeHours } from "../../_personnel/format";
import { jobChips } from "../../_personnel/JobRow";
import { HideVendorButton } from "../../_personnel/HideVendorButton";
import { personnelActor } from "../../_personnel/session";
import { DeputyNoteForm } from "./DeputyNoteForm";
import { OpsPlanUpload } from "./OpsPlanUpload";
import { SafetyMap } from "./SafetyMap";
import { SignUpPanel, type PositionChoice, type TimeOption } from "./SignUpPanel";
import { WatchSwitch } from "./WatchSwitch";

export const metadata: Metadata = { title: "Detail" };

type Props = { params: Promise<{ id: string }> };

const QUARTER = 15 * 60_000;
const ROLE: Record<string, string> = { admin: "admin", coordinator: "coordinator", personnel: "deputy", vendor: "vendor" };

/** What a met rule says (a failing rule shows the service's exact message instead). */
function passLabel(c: CheckResult, windowHours: number): string {
  switch (c.check) {
    case "state":
      return "Open for sign-up";
    case "vendor_hold":
      return "Vendor in good standing";
    case "vendor_restricted":
      return "Available to you";
    case "rank":
      return "Your rank qualifies";
    case "qualification":
      return "You have the required flags";
    case "active":
      return "Your account is active";
    case "billing_lock":
      return "Billing is up to date";
    case "overlap":
      return "No overlap with your other details";
    case "cap_rolling":
      return `Within the ${windowHours}-hour cap`;
    case "cap_week":
      return "Within the week cap";
    case "cap_month":
      return "Within the month cap";
    case "already_on_job":
      return "Not already on this detail";
    default:
      return c.message || c.check;
  }
}

function stamp(by: string | null, role: string | null, at: Date | null, verb: string): string | null {
  if (!at) return null;
  return `${verb} by ${by ?? "someone"}${role ? `, ${ROLE[role] ?? role}` : ""}, ${dateLabel(at)}.`;
}

/** One detail: facts, officer safety, about, staffing and roster, notes, sign-up and activity. */
export default async function JobPage({ params }: Props) {
  const { id } = await params;
  // Alerts link vendors here too; their view of a detail is in the portal.
  if ((await loadShell())?.actor.role === "vendor") redirect(`/vendor/details/${id}`);
  const actor = await personnelActor();
  const now = new Date();
  const data = await withTx(async (tx) => {
    let job;
    try {
      job = await getJob(actor, tx, id);
    } catch (e) {
      if (e instanceof NotFoundError) return null;
      throw e;
    }
    const [card] = await loadJobCards(actor, tx, [job], now);
    let eligibility: JobEligibility[] = [];
    try {
      eligibility = await eligibilityByPosition(actor, tx, id, now);
    } catch (e) {
      if (!(e instanceof NotFoundError)) throw e;
    }
    const caps = await capSummary(actor, tx, now);
    const settings = await getSettings(tx);
    const mine = (await myDetails(actor, tx, now)).find((d) => d.job.id === id && !["canceled", "removed"].includes(d.status)) ?? null;
    return {
      claimPositionId: mine?.status === "backup" ? await claimablePositionId(tx, mine.assignmentId, now) : null,
      job,
      card,
      eligibility,
      caps,
      settings,
      mine,
      roster: await jobRoster(actor, tx, id),
      activity: await jobActivity(actor, tx, id),
      notes: await deputyNotesForJob(actor, tx, id),
      ops: job.opsPlanRequired ? await getJobOpsPlan(actor, tx, id) : null,
    };
  });
  if (!data) notFound();
  const { job, card, eligibility, settings, mine, roster, caps } = data;

  const started = now.getTime() >= job.startAt.getTime();
  const canNote = mine !== null && ["signed_up", "billed", "paid"].includes(mine.status) && started;
  // Cap rules always show the person's current hours, so a passing cap still says how close it is.
  const capUse: Record<string, CapUse> = { cap_rolling: caps.rolling, cap_week: caps.week, cap_month: caps.month };
  const capDetail = (c: CheckResult) => {
    const use = capUse[c.check];
    if (!use) return undefined;
    return use.limitMinutes === null ? `${wholeHours(use.usedMinutes)} h now, no cap` : `${wholeHours(use.usedMinutes)} / ${wholeHours(use.limitMinutes)} h now`;
  };
  const positions: PositionChoice[] = eligibility.map((e) => {
    const pos = card.positions.find((p) => p.id === e.jobPositionId);
    return {
      id: e.jobPositionId,
      name: pos?.name ?? "Position",
      open: pos ? Math.max(0, pos.count - pos.filled) : 0,
      canSignUp: e.canSignUp,
      canBackup: e.canBackup,
      checks: shownChecks(e.checks).map((c) => ({ label: c.ok ? passLabel(c, settings.rollingCapWindowHours) : c.message, ok: c.ok, cap: c.check in capUse, detail: capDetail(c) })),
    };
  });

  let flex = null;
  if (card.flex && !mine) {
    const starts: TimeOption[] = [];
    const ends: TimeOption[] = [];
    for (let t = card.flex.earliestStartAt.getTime(); t <= card.flex.latestEndAt.getTime(); t += QUARTER) {
      const d = new Date(t);
      if (t < card.flex.latestEndAt.getTime()) starts.push({ value: d.toISOString(), label: clock(d) });
      if (t > card.flex.earliestStartAt.getTime()) ends.push({ value: d.toISOString(), label: clock(d) });
    }
    flex = {
      starts,
      ends,
      start: job.startAt.toISOString(),
      end: job.endAt.toISOString(),
      rangeText: timeRange(card.flex.earliestStartAt, card.flex.latestEndAt),
      shorterNote: card.flex.allowShorter
        ? `Shorter than ${hoursText(card.minutes)} stays pending until ${settings.shortShiftWindowHours} hours before the start.`
        : `Keep the full ${hoursText(card.minutes)}.`,
    };
  }
  const showWatch = !mine && (card.availability === "full" || card.availability === "not_released");
  const safety = job.safety && (job.safety.notes?.trim() || job.safety.addresses.length > 0) ? job.safety : null;
  const latestVersion = data.ops?.versions.at(-1);
  const address = [card.locationName, card.address].filter(Boolean).join(", ");

  return (
    <div className="flex flex-col gap-4.5">
      <Link href="/jobs" className="inline-flex min-h-11 w-fit items-center gap-1 text-sm font-semibold">
        <Icon name="chevronLeft" size={18} />
        Back to details
      </Link>

      <div className="grid gap-4.5 md:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)] md:items-start md:gap-6">
        {/* Phone order follows the mockup: facts, safety, then sign-up; on desktop sign-up stays beside them. */}
        <div className="flex flex-col gap-4.5 md:col-start-1 md:row-start-1">
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
                  {!card.mine && card.maxRateCents > card.rateCents
                    ? card.positions
                        .filter((p) => p.rateCents !== card.rateCents)
                        .map((p) => (
                          <span key={p.id} className="text-sm text-muted">
                            {p.name}: {dollars(p.rateCents)}/hr
                          </span>
                        ))
                    : null}
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
                    <SiteContact name={job.contactName} phone={job.contactPhone} staff={actor.role === "coordinator" || actor.role === "admin"} />
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

          {safety ? (
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
                        <SafetyMap tileUrl={settings.mapTileUrl} attribution={settings.mapAttribution} pin={{ id: a.id, lat: a.lat, lng: a.lng, label: "Safety", name: `Officer safety address: ${a.address}`, tone: "safety" }} />
                      ) : null}
                    </li>
                  ))}
                </ul>
              ) : null}
            </Card>
          ) : null}

        </div>
        <div className="flex flex-col gap-4.5 md:sticky md:top-6 md:col-start-2 md:row-span-2 md:row-start-1 md:self-start">
          <Card tone="accent" id="sign-up" aria-labelledby="signup-title">
            <h2 id="signup-title" className="m-0 text-title font-semibold md:text-base">
              {mine ? "Your sign-up" : "Sign up"}
            </h2>
            {positions.length > 0 ? (
              <SignUpPanel
                jobId={job.id}
                positions={positions}
                warningText={settings.signupWarningText.trim() || "I have read the agency extra duty policy and will work this detail as scheduled."}
                warningVersion={settings.signupWarningVersion}
                flex={flex}
                mine={mine ? { assignmentId: mine.assignmentId, label: mine.label, started, claimPositionId: data.claimPositionId } : null}
              />
            ) : (
              <p className="m-0 text-muted">This detail has no positions to sign up for.</p>
            )}
            {!mine ? <HideVendorButton vendorId={card.vendorId} vendorName={card.vendorName} /> : null}
          </Card>

        </div>
        <div className="flex flex-col gap-4.5 md:col-start-1 md:row-start-2">
          {job.description?.trim() || job.notes?.trim() ? (
            <Card>
              <CardTitle>About</CardTitle>
              {job.description?.trim() ? <p className="m-0 max-w-[70ch] whitespace-pre-line">{job.description}</p> : null}
              {job.notes?.trim() ? <p className="m-0 max-w-[70ch] whitespace-pre-line text-muted">{job.notes}</p> : null}
            </Card>
          ) : null}

          <Card>
            <div className="flex items-center gap-2">
              <CardTitle>Staffing</CardTitle>
              <span className="rounded-full bg-accent-soft px-2 text-xs leading-5.5 font-semibold text-link" data-numeric>
                {card.positions.reduce((n, p) => n + Math.min(p.filled, p.count), 0)} / {card.positions.reduce((n, p) => n + p.count, 0)}
              </span>
            </div>
            <StaffingGrid positions={card.positions.map((p) => ({ id: p.id, name: p.name, filled: p.filled, requested: p.count, backups: p.backups }))} />
          </Card>
          <Table
            caption="Roster"
            columns={[
              { header: "Name", cell: (r) => (r.isYou ? `${r.name} (you)` : r.name) },
              { header: "Position", cell: (r) => r.position },
              { header: "Status", cell: (r) => <Chip tone={r.status === "backup" || r.status === "pending_short" ? "warning" : "info"}>{r.label}</Chip> },
              { header: "Times", cell: (r) => timeRange(r.startAt, r.endAt) },
            ]}
            rows={roster}
            rowKey={(r) => r.assignmentId}
            empty="Nobody has signed up yet."
          />

          {data.ops ? (
            <Card>
              <CardTitle>Ops plan</CardTitle>
              <p className="m-0 text-sm text-muted">
                {data.ops.status === "agreed" ? "Agreed." : data.ops.status === "denied" ? "Denied. A new version is needed." : data.ops.status === "submitted" ? "Submitted, waiting for review." : "Not submitted yet."}
                {data.ops.dueAt ? ` Due ${dateLabel(data.ops.dueAt)} at ${clock(data.ops.dueAt)}.` : ""}
              </p>
              {data.ops.versions.length > 0 ? (
                <ul className="m-0 flex list-none flex-col divide-y divide-divider p-0">
                  {[...data.ops.versions].reverse().map((v) => {
                    const superseded = v.decision === "pending" && v.id !== latestVersion?.id;
                    return (
                      <li key={v.id} className="flex flex-wrap items-center justify-between gap-2 py-2.5">
                        <span className="flex flex-col">
                          <span className="font-medium">{v.filename}</span>
                          <span className="text-xs text-muted">Submitted {dateLabel(v.submittedAt)}</span>
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
              {data.ops.incidentCommanderId === actor.userId && job.state !== "canceled" && job.state !== "declined" ? (
                <OpsPlanUpload jobId={job.id} again={data.ops.versions.length > 0} />
              ) : null}
            </Card>
          ) : null}
          <Card>
            <CardTitle>Deputy notes</CardTitle>
            {data.notes.length === 0 ? (
              <p className="m-0 text-sm text-muted">No notes from other deputies yet.</p>
            ) : (
              <ul className="m-0 flex list-none flex-col gap-3 p-0">
                {data.notes.map((n, i) => (
                  <li key={i} className="flex flex-col gap-1">
                    <p className="m-0 max-w-[65ch] whitespace-pre-line">{n.body}</p>
                    <span className="text-xs text-muted">
                      {n.authorName}, {dateLabel(n.writtenAt)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
            {canNote ? (
              <DeputyNoteForm jobId={job.id} hasLocation={job.locationId !== null} max={DEPUTY_NOTE_MAX} />
            ) : (
              <p className="m-0 text-xs text-muted">After you work this detail you can add a note for future deputies.</p>
            )}
          </Card>

          <Card>
            <CardTitle>Activity</CardTitle>
            {data.activity.length === 0 ? (
              <p className="m-0 text-sm text-muted">No activity yet.</p>
            ) : (
              <ol className="m-0 flex list-none flex-col gap-2 p-0 text-sm">
                {data.activity.map((a) => (
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
        </div>
      </div>
    </div>
  );
}
