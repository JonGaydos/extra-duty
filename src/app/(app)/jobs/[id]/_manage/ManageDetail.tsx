import { notFound } from "next/navigation";
import type { Actor } from "@/domain/actor";
import { agencyDateParts } from "@/domain/time/agency-time";
import type { DetailWire } from "../../../coordinate/_coordinator/detail-input";
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

const hhmm = (d: Date) => {
  const p = agencyDateParts(d);
  return `${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`;
};

/**
 * Manage this detail (coordinators and admins, on the shared detail page): request decision, quick edit and edit
 * (one or series), hold and release, cancel and reactivate, the roster and sign-up history with assign and remove,
 * officer safety, the ops plan review, attachments and contract, activity, copy and repeat.
 */
export async function ManageDetail({ actor, id, now }: Readonly<{ actor: Actor; id: string; now: Date }>) {
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
    <div className="flex flex-col gap-4.5" data-testid="manage-detail">
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
