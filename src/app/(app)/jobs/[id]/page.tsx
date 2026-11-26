import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { Card } from "@/ui/components/Card";
import { Chip } from "@/ui/components/Chip";
import { Table } from "@/ui/components/Table";
import { Icon } from "@/ui/icons";
import { loadShell } from "@/ui/shell/load-shell";
import { timeRange } from "../../_personnel/format";
import { HideVendorButton } from "../../_personnel/HideVendorButton";
import { personnelActor } from "../../_personnel/session";
import { loadJobPage } from "./load";
import { ActivityCard, AboutCard, FactsCard, NotesCard, OpsPlanCard, SafetyCard, StaffingCard } from "./sections";
import { flexChoices, positionChoices } from "./sign-up-input";
import { SignUpPanel } from "./SignUpPanel";

export const metadata: Metadata = { title: "Detail" };

type Props = { params: Promise<{ id: string }> };

/** One detail: facts, officer safety, about, staffing and roster, notes, sign-up and activity. */
export default async function JobPage({ params }: Readonly<Props>) {
  const { id } = await params;
  // Alerts link vendors here too; their view of a detail is in the portal.
  if ((await loadShell())?.actor.role === "vendor") redirect(`/vendor/details/${id}`);
  const actor = await personnelActor();
  const now = new Date();
  const data = await loadJobPage(actor, id, now);
  if (!data) notFound();
  const { job, card, settings, mine, roster } = data;

  const started = now.getTime() >= job.startAt.getTime();
  const canNote = mine !== null && ["signed_up", "billed", "paid"].includes(mine.status) && started;
  const positions = positionChoices(data);
  const flex = flexChoices(data);
  const showWatch = !mine && (card.availability === "full" || card.availability === "not_released");
  const safety = job.safety && (job.safety.notes?.trim() || job.safety.addresses.length > 0) ? job.safety : null;

  return (
    <div className="flex flex-col gap-4.5">
      <Link href="/jobs" className="inline-flex min-h-11 w-fit items-center gap-1 text-sm font-semibold">
        <Icon name="chevronLeft" size={18} />
        Back to details
      </Link>

      <div className="grid gap-4.5 md:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)] md:items-start md:gap-6">
        {/* Phone order follows the mockup: facts, safety, then sign-up; on desktop sign-up stays beside them. */}
        <div className="flex flex-col gap-4.5 md:col-start-1 md:row-start-1">
          <FactsCard d={data} staff={actor.role === "coordinator" || actor.role === "admin"} showWatch={showWatch} />

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
                mine={mine ? { assignmentId: mine.assignmentId, label: mine.label, started, claimPositionId: data.claimPositionId } : null}
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
              { header: "Status", render: (r) => <Chip tone={r.status === "backup" || r.status === "pending_short" ? "warning" : "info"}>{r.label}</Chip> },
              { header: "Times", render: (r) => timeRange(r.startAt, r.endAt) },
            ]}
            rows={roster}
            rowKey={(r) => r.assignmentId}
            empty="Nobody has signed up yet."
          />

          {data.ops ? <OpsPlanCard ops={data.ops} job={job} userId={actor.userId} /> : null}
          <NotesCard d={data} canNote={canNote} />

          <ActivityCard activity={data.activity} />
        </div>
      </div>
    </div>
  );
}
