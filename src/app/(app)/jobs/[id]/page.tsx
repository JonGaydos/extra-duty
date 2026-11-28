import { eq } from "drizzle-orm";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { Card } from "@/ui/components/Card";
import { Chip } from "@/ui/components/Chip";
import { Table } from "@/ui/components/Table";
import { Icon } from "@/ui/icons";
import { loadShell } from "@/ui/shell/load-shell";
import { withTx } from "@/ui/shell/request";
import { jobs } from "@/db/schema";
import { timeRange } from "../../_personnel/format";
import { HideVendorButton } from "../../_personnel/HideVendorButton";
import { personnelActor } from "../../_personnel/session";
import { TabLinks } from "../../_personnel/TabLinks";
import { parseDetailNumber, visibleJobIdByNumber, visibleJobNumber } from "@/domain/jobs/detail-number";
import { isVendorManager, managesVendor } from "@/domain/auth/policy";
import { jobVendorId } from "@/domain/auth/scope";
import type { Actor } from "@/domain/actor";
import { loadJobPage } from "./load";
import { ManageDetail } from "./_manage/ManageDetail";
import { ActivityCard, AboutCard, FactsCard, NotesCard, OpsPlanCard, SafetyCard, StaffingCard } from "./sections";
import { flexChoices, positionChoices } from "./sign-up-input";
import { SignUpPanel } from "./SignUpPanel";

export const metadata: Metadata = { title: "Detail" };

type Props = { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> };

type Tab = "detail" | "manage";

/** The page's query string again, for a redirect that keeps it. */
function queryOf(sp: Record<string, string | string[] | undefined>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(sp)) for (const x of [v].flat()) if (x !== undefined) q.append(k, x);
  return q.toString();
}

/**
 * Staff open a detail on Detail (what deputies see), except a vendor request or a declined request, which opens on
 * Manage. `?tab=` picks one.
 */
async function staffTab(id: string, asked: string | string[] | undefined): Promise<Tab | null> {
  const [row] = await withTx((tx) => tx.select({ state: jobs.state }).from(jobs).where(eq(jobs.id, id)));
  if (!row) return null;
  if (asked === "detail" || asked === "manage") return asked;
  return row.state === "requested" || row.state === "declined" ? "manage" : "detail";
}

/** Detail and Manage this detail, for coordinators and admins, and for a vendor manager on their vendor's details. */
function StaffTabs({ number, current }: Readonly<{ number: number; current: Tab }>) {
  return (
    <TabLinks
      label="Detail sections"
      current={current}
      items={[
        { key: "detail", label: "Detail", href: `/jobs/${number}?tab=detail` },
        { key: "manage", label: "Manage this detail", href: `/jobs/${number}?tab=manage` },
      ]}
    />
  );
}

/** A vendor manager gets Manage this detail on their vendors' details (owner decision 2026-11-27). */
async function managesDetail(actor: Actor, id: string): Promise<boolean> {
  return isVendorManager(actor) && managesVendor(actor, await withTx((tx) => jobVendorId(tx, id)));
}

const BackLink = () => (
  <Link href="/jobs" className="inline-flex min-h-11 w-fit items-center gap-1 text-sm font-semibold">
    <Icon name="chevronLeft" size={18} />
    Back to details
  </Link>
);

/**
 * One detail, the same page for everyone: facts, officer safety, about, staffing and roster, notes, sign-up and
 * activity. Coordinators and admins also get a Manage this detail tab with every staff control on the detail, and so
 * does a vendor manager on their vendors' details, without the coordinator-only controls.
 */
export default async function JobPage({ params, searchParams }: Readonly<Props>) {
  const { id: ref } = await params;
  const sp = await searchParams;
  const number = parseDetailNumber(ref);
  const shell = await loadShell();
  // Alerts link vendors here too; their view of a detail is in the portal.
  if (shell?.actor.role === "vendor") {
    const vendorJob = number === null ? ref : await withTx((tx) => visibleJobIdByNumber(shell.actor, tx, number));
    if (!vendorJob) notFound();
    redirect(`/vendor/details/${vendorJob}`);
  }
  const actor = await personnelActor();
  // The address is the detail's number (/jobs/9). An old id address moves to it, with its query; a detail the person
  // may not see is not found either way.
  if (number === null) {
    const n = await withTx((tx) => visibleJobNumber(actor, tx, ref));
    if (n === null) notFound();
    const q = queryOf(sp);
    redirect(q ? `/jobs/${n}?${q}` : `/jobs/${n}`);
  }
  const id = await withTx((tx) => visibleJobIdByNumber(actor, tx, number));
  if (!id) notFound();
  const staff = actor.role === "coordinator" || actor.role === "admin";
  const manages = staff || (await managesDetail(actor, id));
  const now = new Date();
  const tab = manages ? await staffTab(id, sp.tab) : "detail";
  if (!tab) notFound();
  if (tab === "manage") {
    return (
      <div className="flex flex-col gap-4.5">
        <BackLink />
        <StaffTabs number={number} current="manage" />
        <ManageDetail actor={actor} id={id} now={now} coordinator={staff} />
      </div>
    );
  }
  const data = await loadJobPage(actor, id, now);
  if (!data) notFound();
  return <DetailView data={data} staff={staff} manages={manages} userId={actor.userId} now={now} />;
}

/** The Detail tab: what everyone sees. */
function DetailView({ data, staff, manages, userId, now }: Readonly<{ data: NonNullable<Awaited<ReturnType<typeof loadJobPage>>>; staff: boolean; manages: boolean; userId: string; now: Date }>) {
  const { job, card, settings, mine, roster } = data;

  const started = now.getTime() >= job.startAt.getTime();
  const canNote = mine !== null && ["signed_up", "billed", "paid"].includes(mine.status) && started;
  const positions = positionChoices(data);
  const flex = flexChoices(data);
  // A confidential detail is never released, so there is nothing to watch for.
  const showWatch = !mine && !job.confidential && (card.availability === "full" || card.availability === "not_released");
  const safety = job.safety && (job.safety.notes?.trim() || job.safety.addresses.length > 0) ? job.safety : null;

  return (
    <div className="flex flex-col gap-4.5">
      <BackLink />
      {manages ? <StaffTabs number={job.number} current="detail" /> : null}

      <div className="grid gap-4.5 md:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)] md:items-start md:gap-6">
        {/* Phone order follows the mockup: facts, safety, then sign-up; on desktop sign-up stays beside them. */}
        <div className="flex flex-col gap-4.5 md:col-start-1 md:row-start-1">
          <FactsCard d={data} staff={staff} showWatch={showWatch} />

          {safety ? <SafetyCard safety={safety} tileUrl={settings.mapTileUrl} attribution={settings.mapAttribution} /> : null}
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
                mine={
                  mine
                    ? {
                        assignmentId: mine.assignmentId,
                        label: mine.label,
                        status: mine.status,
                        started,
                        claimPositionId: data.claimPositionId,
                        offered: card.offered && !started,
                        confidential: job.confidential,
                        messageHref: `/messages/new?about=${job.id}`,
                      }
                    : null
                }
                ended={data.ended}
              />
            ) : (
              <p className="m-0 text-muted">This detail has no positions to sign up for.</p>
            )}
            {!mine ? <HideVendorButton vendorId={card.vendorId} vendorName={card.vendorName} /> : null}
          </Card>
        </div>
        <div className="flex flex-col gap-4.5 md:col-start-1 md:row-start-2">
          <AboutCard job={job} />
          <StaffingCard card={card} />
          <Table
            caption="Roster"
            columns={[
              { header: "Name", render: (r) => (r.isYou ? `${r.name} (you)` : r.name) },
              { header: "Position", render: (r) => r.position },
              { header: "Status", render: (r) => <Chip tone={r.offered || r.status === "backup" || r.status === "pending_short" ? "warning" : "info"}>{r.label}</Chip> },
              { header: "Times", render: (r) => timeRange(r.startAt, r.endAt) },
            ]}
            rows={roster}
            rowKey={(r) => r.assignmentId}
            empty="Nobody has signed up yet."
          />

          {data.ops ? <OpsPlanCard ops={data.ops} job={job} userId={userId} /> : null}
          <NotesCard d={data} canNote={canNote} />

          <ActivityCard activity={data.activity} />
        </div>
      </div>
    </div>
  );
}
