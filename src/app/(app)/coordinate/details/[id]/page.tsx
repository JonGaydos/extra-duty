import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { agencyDateParts } from "@/domain/time/agency-time";
import { Icon } from "@/ui/icons";
import { coordinatorActor } from "../../_coordinator/session";
import type { DetailWire } from "../../_coordinator/detail-input";
import { loadDetail } from "./load";
import {
  AttachmentsCard,
  CopyAndRepeat,
  DetailHeader,
  FactsCard,
  ManageCard,
  NotesAndActivity,
  OpsPlanCard,
  QuickEditCard,
  SafetyCard,
  StaffingCard,
  VendorAsks,
  releaseStatusText,
  type DetailContext,
} from "./sections";

export const metadata: Metadata = { title: "Detail" };

type Props = { params: Promise<{ id: string }> };

const hhmm = (d: Date) => {
  const p = agencyDateParts(d);
  return `${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`;
};

/** A detail as a coordinator runs it: request decision, edit (one or series), roster actions, ops plan review, copy, repeat and cancel. */
export default async function CoordinatorDetailPage({ params }: Readonly<Props>) {
  const actor = await coordinatorActor();
  const { id } = await params;
  const now = new Date();
  const data = await loadDetail(actor, id, now);
  if (!data) notFound();
  const { job, ops } = data;
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
  const c: DetailContext = {
    d: data,
    now,
    started: job.startAt.getTime() <= now.getTime(),
    closed: job.state === "canceled" || job.state === "declined",
    releaseStatus: releaseStatusText(job, now),
    initial,
  };

  return (
    <div className="flex flex-col gap-4.5">
      <Link href="/coordinate/details" className="inline-flex min-h-11 w-fit items-center gap-1 text-sm font-semibold">
        <Icon name="chevronLeft" size={18} />
        Back to details
      </Link>
      <DetailHeader c={c} />

      <div className="grid gap-4.5 md:grid-cols-[minmax(0,1fr)_340px] md:grid-rows-[auto_1fr] md:items-start md:gap-6">
        {/* Manage comes first on phones; on desktop it heads the right column. */}
        <div className="flex flex-col gap-4.5 md:col-start-2 md:row-start-1">
          {job.state !== "requested" ? <QuickEditCard c={c} /> : null}
          <ManageCard c={c} />
        </div>

        <div className="flex min-w-0 flex-col gap-4.5 md:col-start-1 md:row-span-2 md:row-start-1">
          <VendorAsks c={c} />
          <FactsCard c={c} />
          <SafetyCard c={c} />
          <StaffingCard c={c} />
          {ops ? <OpsPlanCard c={c} ops={ops} /> : null}
          <AttachmentsCard c={c} />
          <NotesAndActivity c={c} />
        </div>

        <CopyAndRepeat c={c} />
      </div>
    </div>
  );
}
