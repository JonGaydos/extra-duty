import type { Metadata } from "next";
import Link from "next/link";
import { eq } from "drizzle-orm";
import { withTx } from "@/ui/shell/request";
import { assignments, jobs, users, vendors } from "@/db/schema";
import { lateCancelMinutes, resolveMinimum } from "@/domain/billing/rules";
import { activePaymentMethods, toBill, toBillFor } from "@/domain/personnel/views";
import { getSettings } from "@/domain/settings/settings";
import { getOwnContact } from "@/domain/users/contact";
import { currentW9 } from "@/domain/w9/w9";
import { Card } from "@/ui/components/Card";
import { EmptyState } from "@/ui/components/EmptyState";
import { Icon } from "@/ui/icons";
import { dateLabel, dayLabel, localInput, relativeDay, timeRange } from "../../../_personnel/format";
import { personnelActor } from "../../../_personnel/session";
import { BillForm } from "./BillForm";

export const metadata: Metadata = { title: "Bill this detail" };

type Props = { params: Promise<{ id: string }> };

/** The billing form for one worked (or late-canceled) detail of the person's own, or, for staff, of someone they bill for. */
export default async function BillPage({ params }: Readonly<Props>) {
  const actor = await personnelActor();
  const { id } = await params;
  const now = new Date();
  const staff = actor.role === "coordinator" || actor.role === "admin";
  const data = await withTx(async (tx) => {
    let owner = actor.userId;
    let item = (await toBill(actor, tx, now)).find((b) => b.assignmentId === id);
    // Staff may bill someone else's detail on their behalf (someone who left the agency, for one).
    if (!item && staff) {
      const [a] = await tx.select({ userId: assignments.userId }).from(assignments).where(eq(assignments.id, id));
      if (a && a.userId !== actor.userId) {
        owner = a.userId;
        item = (await toBillFor(actor, tx, owner, now)).find((b) => b.assignmentId === id);
      }
    }
    if (!item) return null;
    const [row] = await tx
      .select({ jobMin: jobs.minimumBillableMinutes, vendorMin: vendors.minimumBillableMinutes, emails: vendors.billingEmails, jobStart: jobs.startAt, jobEnd: jobs.endAt })
      .from(assignments)
      .innerJoin(jobs, eq(jobs.id, assignments.jobId))
      .innerJoin(vendors, eq(vendors.id, jobs.vendorId))
      .where(eq(assignments.id, id));
    return {
      item,
      row,
      settings: await getSettings(tx),
      contact: owner === actor.userId ? await getOwnContact(actor, tx) : (await tx.select({ name: users.name, mailingAddress: users.mailingAddress }).from(users).where(eq(users.id, owner)))[0],
      w9: await currentW9(tx, owner),
      owner,
      methods: await activePaymentMethods(tx),
    };
  });

  const onBehalf = data && data.owner !== actor.userId ? { backHref: `/admin/users/${data.owner}`, backLabel: `Back to ${data.contact.name}` } : undefined;
  const back = (
    <Link href={onBehalf?.backHref ?? "/billing"} className="inline-flex min-h-11 w-fit items-center gap-1 text-sm font-semibold">
      <Icon name="chevronLeft" size={18} />
      {onBehalf?.backLabel ?? "Back to billing"}
    </Link>
  );
  if (!data) {
    return (
      <div className="flex flex-col gap-4.5">
        {back}
        <h1 className="m-0 text-2xl font-bold md:text-3xl">Bill this detail</h1>
        <Card pad={false}>
          <EmptyState title="Nothing to bill here">This detail is already billed, has not ended yet, or is not yours.</EmptyState>
        </Card>
      </div>
    );
  }
  const { item, row, settings } = data;
  const minimum = resolveMinimum(row.jobMin, row.vendorMin, settings.minimumBillableMinutes);

  return (
    <div className="mx-auto flex w-full max-w-160 flex-col gap-4.5">
      {back}
      <div className="flex flex-col gap-1">
        <h1 className="m-0 text-2xl font-bold md:text-3xl">{onBehalf ? `Bill for ${data.contact.name}` : "Bill this detail"}</h1>
        <p className="m-0 text-muted">
          #{item.jobNumber} {item.vendorName}, {relativeDay(item.startAt, now) === "Today" ? "today" : dayLabel(item.startAt)}. Scheduled {timeRange(item.startAt, item.endAt)}.
        </p>
      </div>
      <BillForm
        assignmentId={item.assignmentId}
        plannedStart={localInput(item.startAt)}
        plannedEnd={localInput(item.endAt)}
        lateCancel={item.lateCancel}
        lateCancelMinutes={
          item.lateCancel
            ? lateCancelMinutes({ startAt: row.jobStart, endAt: row.jobEnd }, { lateCancelPayBasis: settings.lateCancelPayBasis, minimumBillableMinutes: minimum, hourRoundingMinutes: settings.hourRoundingMinutes })
            : 0
        }
        rateCents={item.rateCents}
        rounding={settings.hourRoundingMinutes}
        minimum={minimum}
        reviewMode={settings.invoiceReviewMode}
        w9={data.w9 ? dateLabel(data.w9.uploadedAt) : null}
        sendsTo={row.emails}
        payee={data.contact.name}
        mailingAddress={data.contact.mailingAddress}
        methods={data.methods}
        onBehalf={onBehalf}
      />
    </div>
  );
}
