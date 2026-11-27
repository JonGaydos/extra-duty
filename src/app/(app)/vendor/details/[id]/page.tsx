import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { withTx } from "@/ui/shell/request";
import { NotFoundError, RuleViolation } from "@/domain/errors";
import { getJob } from "@/domain/jobs/jobs";
import { vendorViewJob } from "@/domain/vendor-portal/requests";
import { vendorJobControls, vendorStatus } from "@/domain/vendor-portal/views";
import { Card, CardTitle } from "@/ui/components/Card";
import { Chip } from "@/ui/components/Chip";
import { SiteContact } from "@/ui/components/ContactList";
import { MapsLink } from "@/ui/components/MapsLink";
import { Notice } from "@/ui/components/Notice";
import { StaffingGrid } from "@/ui/components/StaffingGrid";
import { Icon } from "@/ui/icons";
import { dateLabel, dayLabel, timeRange } from "../../../_personnel/format";
import { StatusChip } from "../../_vendor/DetailRows";
import { vendorActor } from "../../_vendor/session";
import { spanInputs } from "../../_vendor/span";
import { DetailActions } from "./DetailActions";
import { keyedByContent } from "@/lib/list-keys";

export const metadata: Metadata = { title: "Detail" };

type Props = { params: Promise<{ id: string }> };

function BackLink() {
  return (
    <Link href="/vendor" className="inline-flex min-h-11 w-fit items-center gap-1 text-sm font-semibold">
      <Icon name="chevronLeft" size={18} />
      Back to my details
    </Link>
  );
}

type Loaded = { view: Awaited<ReturnType<typeof vendorViewJob>>; job: Awaited<ReturnType<typeof getJob>>; controls: Awaited<ReturnType<typeof vendorJobControls>> };

/** A contract on the detail: a link, a file to download, or its label alone. */
function ContractLink({ c, jobId }: Readonly<{ c: Loaded["view"]["contracts"][number]; jobId: string }>) {
  if (c.url)
    return (
      <a href={c.url} target="_blank" rel="noreferrer noopener" className="inline-flex min-h-11 items-center gap-1 text-sm font-semibold">
        {c.label}
        <span className="sr-only">, opens in a new tab</span>
        <Icon name="external" size={16} />
      </a>
    );
  if (c.fileId)
    return (
      <a href={`/api/v1/jobs/${jobId}/attachments/${c.id}/file`} className="inline-flex min-h-11 items-center gap-1 text-sm font-semibold" download>
        {c.label}
        <span className="sr-only">, download</span>
        <Icon name="download" size={16} />
      </a>
    );
  return <span className="text-sm">{c.label}</span>;
}

/** Waiting for approval (the request or a change), canceled or declined, with the reason. */
function DetailNotices({ view, job, controls }: Readonly<Loaded>) {
  const reason = job.cancelReason ? `: ${job.cancelReason}` : ".";
  return (
    <>
      {view.state === "requested" ? <Notice tone="info">Waiting for coordinator approval. Deputies can sign up once a coordinator approves it.</Notice> : null}
      {controls.pendingChange ? (
        <Notice tone="warning">Waiting for coordinator approval: you asked on {dateLabel(controls.pendingChange.requestedAt)} to change the date, time or headcount. The detail below shows the current plan.</Notice>
      ) : null}
      {view.state === "canceled" ? <Notice tone="warning">Canceled{reason}</Notice> : null}
      {view.state === "declined" ? <Notice tone="warning">The coordinators declined this request{reason}</Notice> : null}
    </>
  );
}

/** The detail's status, title and notices, when and where, the site contact, description and notes. */
function DetailCard({ view, job, controls, status }: Readonly<Loaded & { status: Parameters<typeof StatusChip>[0]["status"] }>) {
  return (
    <Card>
      <div className="flex flex-wrap items-center gap-1.5">
        <StatusChip status={status} />
        <Chip>Detail #{view.number}</Chip>
      </div>
      <h1 className="m-0 text-2xl font-bold md:text-3xl">{view.title}</h1>
      <DetailNotices view={view} job={job} controls={controls} />
      <dl className="m-0 grid gap-3 border-t border-divider pt-3 sm:grid-cols-2">
        <div className="flex flex-col gap-0.5">
          <dt className="text-xs font-semibold text-muted">When</dt>
          <dd className="m-0 flex flex-col">
            <b>{dayLabel(view.startAt)}</b>
            <span>{timeRange(view.startAt, view.endAt)}</span>
          </dd>
        </div>
        {view.location ? (
          <div className="flex flex-col gap-0.5">
            <dt className="text-xs font-semibold text-muted">Where</dt>
            <dd className="m-0 flex flex-col">
              <b>{view.location.name}</b>
              {view.location.address ? <span>{view.location.address}</span> : null}
              {view.location.address || view.location.lat !== null ? <MapsLink address={view.location.address} lat={view.location.lat} lng={view.location.lng} /> : null}
            </dd>
          </div>
        ) : null}
        {job.contactName || job.contactPhone ? (
          <div className="flex flex-col gap-0.5 sm:col-span-2">
            <dt className="text-xs font-semibold text-muted">Contact on site</dt>
            <dd className="m-0">
              <SiteContact name={job.contactName} phone={job.contactPhone} staff={false} />
            </dd>
          </div>
        ) : null}
      </dl>
      {view.description ? (
        <div className="flex flex-col gap-1 border-t border-divider pt-3">
          <h2 className="m-0 text-xs font-semibold text-muted">What the deputies will do</h2>
          <p className="m-0 max-w-[70ch] whitespace-pre-line">{view.description}</p>
        </div>
      ) : null}
      {view.notes ? (
        <div className="flex flex-col gap-1 border-t border-divider pt-3">
          <h2 className="m-0 text-xs font-semibold text-muted">Notes</h2>
          <p className="m-0 max-w-[70ch] whitespace-pre-line">{view.notes}</p>
        </div>
      ) : null}
    </Card>
  );
}

/**
 * One of the vendor's details: when and where, staffing (names once filled, never contact details), contracts,
 * and the changes the vendor settings allow. Another vendor's detail is not found.
 */
export default async function VendorDetailPage({ params }: Readonly<Props>) {
  const actor = await vendorActor();
  const { id } = await params;
  const now = new Date();
  const data = await withTx(async (tx) => {
    try {
      const view = await vendorViewJob(actor, tx, id, now);
      const job = await getJob(actor, tx, id);
      return { view, job, controls: await vendorJobControls(actor, tx, id, now), held: false as const };
    } catch (e) {
      if (e instanceof NotFoundError) return null;
      if (e instanceof RuleViolation && e.checks.some((c) => c.check === "vendor_hold")) return { held: true as const };
      throw e;
    }
  });
  if (!data) notFound();
  if (data.held) {
    return (
      <div className="flex flex-col gap-4.5">
        <BackLink />
        <h1 className="m-0 text-2xl font-bold md:text-3xl">Detail locked</h1>
        <Card tone="danger">
          <p className="m-0 text-danger-ink">Your account is on payment hold, so this upcoming detail is locked. Call the coordinators to resolve the hold.</p>
        </Card>
      </div>
    );
  }

  const { view, job, controls } = data;
  const needed = view.positions.reduce((n, p) => n + p.count, 0);
  const filled = view.positions.reduce((n, p) => n + Math.min(p.filled, p.count), 0);
  const status = vendorStatus(view, needed, filled, now);
  const assigned = view.positions.flatMap((p) => (p.assigned ?? []).map((a) => ({ ...a, position: p.name })));
  const namesShown = view.positions.some((p) => p.assigned !== null);

  return (
    <div className="flex flex-col gap-4.5">
      <BackLink />
      <div className="grid gap-4.5 md:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)] md:items-start md:gap-6">
        <div className="flex min-w-0 flex-col gap-4.5">
          <DetailCard view={view} job={job} controls={controls} status={status} />

          <Card>
            <CardTitle>Staffing</CardTitle>
            <StaffingGrid positions={view.positions.map((p) => ({ id: p.id, name: p.name, filled: p.filled, requested: p.count, backups: 0 }))} />
            {namesShown ? (
              <ul className="m-0 flex list-none flex-col divide-y divide-divider border-t border-divider p-0">
                {keyedByContent(assigned).map(({ key, item: a }) => (
                  <li key={key} className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 py-2.5">
                    <span className="font-semibold">{a.name}</span>
                    <span className="text-sm text-muted">
                      {a.position}, {timeRange(a.plannedStartAt, a.plannedEndAt)}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="m-0 text-sm text-muted">The names of the people working it show here once every spot is filled.</p>
            )}
          </Card>
        </div>

        <div className="flex flex-col gap-4.5">
          <DetailActions
            jobId={view.id}
            requested={view.state === "requested"}
            current={{ ...spanInputs(view.startAt, view.endAt), description: view.description ?? "", notes: view.notes ?? "" }}
            positions={controls.positions}
            edit={controls.edit}
            schedule={controls.schedule}
            cancel={controls.cancel}
            signedUp={controls.signedUp}
          />
          {view.contracts.length ? (
            <Card>
              <CardTitle>Contract</CardTitle>
              <ul className="m-0 flex list-none flex-col gap-1 p-0">
                {view.contracts.map((c) => (
                  <li key={c.id}>
                    <ContractLink c={c} jobId={view.id} />
                  </li>
                ))}
              </ul>
            </Card>
          ) : null}
        </div>
      </div>
    </div>
  );
}
