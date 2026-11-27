"use server";

import { vendorMarkPaid } from "@/domain/billing/payments";
import { ValidationError } from "@/domain/errors";
import { agencyDateOnly } from "@/domain/time/agency-time";
import { assertCan } from "@/domain/auth/policy";
import { getJob } from "@/domain/jobs/jobs";
import { expandSelection, type DateSelection } from "@/domain/jobs/recurrence";
import { vendorCancelJob, vendorEditJob, type VendorEditPatch } from "@/domain/vendor-portal/requests";
import { addLocation, updateLocation, type LocationInput } from "@/domain/vendors/vendors";
import { act, type ActionResult } from "../../_personnel/result";
import { spanFromInputs } from "./span";

/** Server actions for the vendor portal: each checks the person, calls one service and reports back. */

type PositionCount = { positionTypeId: string; count: number };

const counts = (list: PositionCount[]): PositionCount[] => {
  for (const p of list) {
    if (!Number.isInteger(p.count) || p.count < 1 || p.count > 99) throw new ValidationError("Enter how many people, from 1 to 99.");
  }
  return list;
};

const span = (date: string, start: string, end: string) => {
  const s = spanFromInputs(date, start, end);
  if (!s) throw new ValidationError("Enter the date and the start and end times.");
  return s;
};

/** Expands a range or repeat of request dates by the same rules the coordinators use. */
export async function expandRequestDatesAction(selection: DateSelection, firstDate: string): Promise<ActionResult> {
  // act() takes a promise-returning callback; nothing here waits, so the result is returned already resolved.
  return act((actor) => {
    assertCan(actor, "vendorRequest.submit", { vendorId: actor.vendorId ?? undefined });
    return Promise.resolve({ ok: true, value: JSON.stringify(expandSelection(selection, firstDate)) });
  });
}

export type EditInput = {
  jobId: string;
  /** Present only when the date and times may change. */
  when: { date: string; start: string; end: string } | null;
  positions: PositionCount[] | null;
  text: { description: string; notes: string } | null;
};

export async function editDetailAction(input: EditInput): Promise<ActionResult> {
  return act(async (actor, tx) => {
    const patch: VendorEditPatch = {
      ...(input.when ? span(input.when.date, input.when.start, input.when.end) : {}),
      ...(input.positions ? { positions: counts(input.positions) } : {}),
      ...(input.text ? { description: input.text.description, notes: input.text.notes } : {}),
    };
    const r = await vendorEditJob(actor, tx, input.jobId, patch);
    return { ok: true, message: r.applied ? "Changes saved." : "Waiting for coordinator approval. We will let you know when they decide." };
  });
}

export async function cancelDetailAction(input: { jobId: string; reason: string }): Promise<ActionResult> {
  return act(async (actor, tx) => {
    // A request a coordinator has not approved yet is withdrawn, not canceled: nobody is signed up to tell.
    const { state } = await getJob(actor, tx, input.jobId);
    await vendorCancelJob(actor, tx, input.jobId, input.reason);
    return { ok: true, message: state === "requested" ? "Request withdrawn." : "Detail canceled. Everyone signed up is told." };
  });
}

export async function vendorMarkPaidAction(input: { invoiceId: string; paidDate: string; methodId: string; reference: string; note: string }): Promise<ActionResult> {
  return act(async (actor, tx) => {
    const paidAt = agencyDateOnly(input.paidDate);
    if (!paidAt) throw new ValidationError("Enter the date you paid.");
    if (!input.methodId) throw new ValidationError("Choose how you paid.");
    const inv = await vendorMarkPaid(actor, tx, input.invoiceId, { paidAt, paymentMethodId: input.methodId, reference: input.reference, note: input.note });
    return { ok: true, message: inv.status === "paid" ? "Marked paid for your records." : "Marked paid. The deputy confirms when the money arrives." };
  });
}

type LocationWire = { name: string; address: string; notes: string; pin?: Exclude<LocationInput["pin"], undefined> };

export async function addLocationAction(input: LocationWire): Promise<ActionResult> {
  return act(async (actor, tx) => {
    if (!actor.vendorId) throw new ValidationError("Only a vendor login can add its locations.");
    await addLocation(actor, tx, actor.vendorId, { name: input.name, address: input.address || null, notes: input.notes, pin: input.pin });
    return { ok: true, message: "Location added." };
  });
}

export async function updateLocationAction(input: LocationWire & { locationId: string }): Promise<ActionResult> {
  return act(async (actor, tx) => {
    await updateLocation(actor, tx, input.locationId, { name: input.name, address: input.address || null, notes: input.notes, pin: input.pin });
    return { ok: true, message: "Location saved." };
  });
}
