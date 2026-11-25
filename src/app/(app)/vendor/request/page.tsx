import type { Metadata } from "next";
import { withTx } from "@/ui/shell/request";
import { getSettings } from "@/domain/settings/settings";
import { agencyDayKey } from "@/domain/time/agency-time";
import { vendorRequestOptions } from "@/domain/vendor-portal/views";
import { Card } from "@/ui/components/Card";
import { PageTitle } from "../../_personnel/TabLinks";
import { vendorActor } from "../_vendor/session";
import { RequestForm } from "./RequestForm";

export const metadata: Metadata = { title: "Request a detail" };

/** A new detail request: where, when, who, what, the site contact and an optional contract link. */
export default async function RequestPage() {
  const actor = await vendorActor();
  const { o, weekStartsOn } = await withTx(async (tx) => ({ o: await vendorRequestOptions(actor, tx), weekStartsOn: (await getSettings(tx)).weekStartsOn }));
  const r = o.rules;
  const min = Math.round((r.minimumBillableMinutes / 60) * 100) / 100;
  const rules = [
    `Requests must be at least ${r.minNoticeHours} hours ahead.`,
    `Changes are locked within ${r.editLockHours} hours of the start.`,
    `Cancelling within ${r.lateCancelHours} hours of the start pays each deputy signed up ${r.lateCancelPayBasis === "scheduled" ? "the scheduled hours" : `the ${min}-hour minimum`}.`,
    `Every detail bills at least ${min} hours.`,
  ];

  return (
    <div className="flex flex-col gap-4.5">
      <PageTitle sub="A coordinator reviews every request before deputies can sign up.">Request a detail</PageTitle>
      {o.onHold ? (
        <Card tone="danger">
          <p className="m-0 font-semibold text-danger-ink">Requests are paused</p>
          <p className="m-0 text-sm text-danger-ink">Your account is on payment hold. Call the coordinators to resolve it.</p>
        </Card>
      ) : o.positionTypes.length === 0 || o.jobTypes.length === 0 ? (
        <Card>
          <p className="m-0 text-sm text-muted">Requests are not set up yet. Call the coordinators to request a detail.</p>
        </Card>
      ) : (
        <RequestForm
          locations={o.locations}
          contacts={o.contacts}
          jobTypes={o.jobTypes}
          positionTypes={o.positionTypes}
          defaultPositionTypeId={o.defaultPositionTypeId ?? o.positionTypes[0].id}
          canSetRate={o.vendorCanSetRate}
          rules={rules}
          today={agencyDayKey(new Date())}
          weekStartsOn={weekStartsOn}
        />
      )}
    </div>
  );
}
