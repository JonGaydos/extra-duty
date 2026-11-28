import type { Metadata } from "next";
import Link from "next/link";
import { withTx } from "@/ui/shell/request";
import { detailFormOptions } from "@/domain/coordinator/views";
import { NotFoundError } from "@/domain/errors";
import { getJob } from "@/domain/jobs/jobs";
import { agencyDateParts, agencyDayKey } from "@/domain/time/agency-time";
import { Icon } from "@/ui/icons";
import { detailCreatorActor } from "../../manage/session";
import { reminderWire, type DetailWire } from "../../coordinate/_coordinator/detail-input";
import { emptyDetail } from "../../coordinate/_coordinator/empty-detail";
import { DetailForm } from "./DetailForm";

export const metadata: Metadata = { title: "New detail" };

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

const hhmm = (d: Date) => {
  const p = agencyDateParts(d);
  return `${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`;
};

/** New detail, or a copy of one (`?from=<job id>`) with every field filled in and no dates chosen. */
export default async function NewDetailPage({ searchParams }: Readonly<Props>) {
  const actor = await detailCreatorActor();
  const sp = await searchParams;
  const from = typeof sp.from === "string" ? sp.from : undefined;
  const { options, source } = await withTx(async (tx) => {
    const options = await detailFormOptions(actor, tx);
    let source = null;
    if (from) {
      try {
        source = await getJob(actor, tx, from);
      } catch (e) {
        if (!(e instanceof NotFoundError)) throw e;
      }
    }
    return { options, source };
  });
  let initial: DetailWire = emptyDetail(options);
  if (source) {
    initial = {
      ...initial,
      vendorId: source.vendorId,
      locationId: source.locationId ?? "",
      typeId: source.typeId,
      title: source.title,
      description: source.description ?? "",
      notes: source.notes ?? "",
      startTime: hhmm(source.startAt),
      endTime: hhmm(source.endAt),
      rate: String(source.rateCents / 100),
      positions: source.positions.map((p) => ({ positionTypeId: p.positionTypeId, count: p.count })),
      opsPlanRequired: source.opsPlanRequired,
      contactName: source.contactName ?? "",
      contactPhone: source.contactPhone ?? "",
      held: source.held,
      // A copy of a confidential detail starts confidential; the new detail needs its own reason.
      confidential: source.confidential,
      confidentialReason: "",
      flex: source.flexEarliestStartAt && source.flexLatestEndAt ? { earliest: hhmm(source.flexEarliestStartAt), latest: hhmm(source.flexLatestEndAt), allowShorter: source.flexAllowShorter } : null,
      safetyNotes: source.safety?.notes ?? "",
      safetyAddresses: source.safety?.addresses.map((a) => ({ address: a.address, description: a.description ?? "", lat: a.lat, lng: a.lng, source: a.source })) ?? [],
      reminders: reminderWire(source.reminderHours),
      reminderNote: source.reminderNote ?? "",
    };
  }

  return (
    <div className="flex flex-col gap-4.5">
      <Link href="/jobs" className="inline-flex min-h-11 w-fit items-center gap-1 text-sm font-semibold">
        <Icon name="chevronLeft" size={18} />
        Back to details
      </Link>
      <h1 className="m-0 text-2xl font-bold md:text-3xl">New detail</h1>
      <DetailForm coordinator={actor.role === "coordinator" || actor.role === "admin"} options={options} initial={initial} today={agencyDayKey(new Date())} fromJobId={source?.id} fromTitle={source ? `#${source.number} ${source.title}` : undefined} />
    </div>
  );
}
