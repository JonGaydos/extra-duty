/**
 * Demo data for training mode and staging: a made-up agency (Bayside County) with about 20 vendors, about 30
 * deputies across every rank, a dispatcher, coordinators and an admin. Every date is generated relative to `today`:
 * 12 past months of worked, billed, paid, overdue, written-off, late-canceled, no-show and payment-issue details and
 * agreed ops plans; the current month in every detail, sign-up and invoice state; and 3 future months of scheduled,
 * open, filled, backup, pending-shorter, flexible-time, officer-safety, held and vendor-on-hold details. Every email
 * address ends in .example, so nothing here can reach a real inbox.
 *
 * buildDemoData is pure (rows with catalog names); loadDemoData writes them into a database that already has the
 * built-in seed (ranks, position and detail types, payment methods).
 */
import { eq } from "drizzle-orm";
import { uuidv7 } from "uuidv7";
import type { Db, Tx } from "./client";
import {
  assignments,
  auditLog,
  invoiceBatches,
  invoices,
  jobPositions,
  jobs,
  jobSafety,
  jobSafetyAddresses,
  jobTypes,
  opsPlans,
  opsPlanVersions,
  paymentIssueNotes,
  paymentIssues,
  paymentMethods,
  positionTypes,
  qualifications,
  ranks,
  settings as settingsTable,
  userQualifications,
  users,
  vendorContacts,
  vendorHolds,
  vendorLocations,
  vendors,
  vendorTypes,
  vendorUsers,
} from "./schema";
import { seed } from "./seed";
import { storeFile } from "../domain/files/files";
import { releaseAt } from "../domain/release/release";
import { DEFAULT_SETTINGS } from "../domain/settings/defaults";
import type { AgencySettings } from "../domain/settings/settings";
import { agencyDateParts, agencyInstant } from "../domain/time/agency-time";
import { PRACTICE_USER_EMAILS } from "../domain/training/mode";

type RankName = "Posse" | "CSO" | "Deputy Sheriff" | "Dispatcher";
type PositionName = "Posse" | "CSO" | "Deputy Sheriff" | "Incident Commander" | "Dispatcher";
type Ins<T extends { $inferInsert: unknown }> = T["$inferInsert"];
type WithId<T> = T & { id: string };

type DemoUser = WithId<Omit<Ins<typeof users>, "id" | "rankId">> & { rank: RankName | null; qualifications: string[] };
type DemoJob = WithId<Omit<Ins<typeof jobs>, "id" | "typeId" | "number">> & { type: string };
type DemoPosition = WithId<Omit<Ins<typeof jobPositions>, "id" | "positionTypeId">> & { positionType: PositionName };
type DemoInvoice = WithId<Omit<Ins<typeof invoices>, "id" | "number" | "deputyMethodId" | "vendorPaidMethodId">> & {
  deputyMethod?: string;
  vendorMethod?: string;
};
type DemoOpsPlan = WithId<Omit<Ins<typeof opsPlans>, "id">> & {
  version: { submittedBy: string; submittedAt: Date; decision: "agreed" | "pending"; decidedBy: string | null; decidedAt: Date | null } | null;
};
type DemoAudit = { action: string; entityType: string; entityId: string; actorUserId: string | null; at: Date; reason?: string; before?: unknown; after?: unknown };

export type DemoData = {
  vendorTypes: WithId<Ins<typeof vendorTypes>>[];
  users: DemoUser[];
  vendors: WithId<Ins<typeof vendors>>[];
  vendorLocations: WithId<Ins<typeof vendorLocations>>[];
  vendorContacts: WithId<Ins<typeof vendorContacts>>[];
  vendorUsers: Ins<typeof vendorUsers>[];
  vendorHolds: Ins<typeof vendorHolds>[];
  jobs: DemoJob[];
  jobPositions: DemoPosition[];
  jobSafety: Ins<typeof jobSafety>[];
  jobSafetyAddresses: Ins<typeof jobSafetyAddresses>[];
  assignments: WithId<Ins<typeof assignments>>[];
  invoiceBatches: WithId<Ins<typeof invoiceBatches>>[];
  invoices: DemoInvoice[];
  paymentIssues: WithId<Ins<typeof paymentIssues>>[];
  paymentIssueNotes: Ins<typeof paymentIssueNotes>[];
  opsPlans: DemoOpsPlan[];
  audit: DemoAudit[];
  /** Overrides of the default settings. */
  settings: Partial<AgencySettings>;
};

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const FIRST = ["Avery", "Blake", "Casey", "Drew", "Emerson", "Finley", "Gray", "Harper", "Jordan", "Kendall", "Logan", "Morgan", "Noel", "Parker", "Quinn", "Reese", "Rowan", "Sawyer", "Taylor", "Tatum", "Wren", "Arden", "Bailey", "Cameron", "Dakota", "Ellis", "Frankie", "Hayden", "Jamie", "Lane", "Marley", "Peyton"];
const LAST = ["Ashford", "Bellamy", "Calder", "Dorsey", "Easton", "Fairbanks", "Garrison", "Holloway", "Ingram", "Jessup", "Kingsley", "Lockhart", "Merritt", "Norwood", "Oakes", "Prescott", "Radford", "Sutton", "Thornton", "Underwood", "Vance", "Whitaker", "Yardley", "Abbott", "Barlow", "Corbin", "Delaney", "Everett", "Fletcher", "Hartley", "Langley", "Mercer"];

const VENDOR_TYPES = ["Events", "Retail", "Construction", "Hospitality", "Schools"];
const VENDOR_NAMES = [
  "Harbor Point Marina",
  "Seabreeze Outdoor Market",
  "Pinecrest Builders",
  "Bayside Amphitheater",
  "Dune Ridge Resort",
  "Coastal Freight Yard",
  "Sandhill Church Fellowship",
  "Gulfview Shopping Center",
  "Redfish Fishing Rodeo",
  "Bayside Unified Schools",
  "Old Mill Brewing Company",
  "Twin Bridges Paving",
  "Sunset Wedding Gardens",
  "Northshore Hospital",
  "Cypress Golf Club",
  "Lighthouse Concert Series",
  "Palmetto Apartments",
  "Bayside Farmers Co-op",
  "Tidewater Utilities",
  "Eastpoint Car Show",
];
const STREETS = ["Harbor Blvd", "Coastal Hwy", "County Rd 100", "Bayshore Dr", "Main St", "Cypress Ave", "Live Oak Ln", "Magnolia St", "Gulf Pkwy", "Pine Ridge Rd"];

const phone = (n: number) => `850-555-${String(100 + n).padStart(4, "0")}`;
const slug = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");

/** A tiny PDF for the demo ops plans. */
const DEMO_PDF = Buffer.from("%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\n% Demo ops plan (training data)\n%%EOF\n");

type Past =
  | "paid"
  | "paid_two"
  | "sent"
  | "paid_on_spot_sent"
  | "written_off"
  | "payment_issue"
  | "issue_resolved"
  | "late_cancel"
  | "no_show"
  | "ops_plan_agreed"
  | "canceled_early"
  | "batched"
  | "returned"
  | "suspension_removal"
  | "unbilled"
  | "pending_review"
  | "ready_to_send"
  | "approved_unsent";
type Future = "open" | "filled" | "backup" | "pending_short" | "flexible" | "officer_safety" | "vendor_on_hold" | "held" | "requested" | "reactivated" | "declined" | "active" | "ops_plan_due";

const PAST_MONTH: Past[] = ["paid_two", "sent", "paid_on_spot_sent", "written_off", "payment_issue", "late_cancel", "no_show", "ops_plan_agreed", "canceled_early", "batched", "returned", "suspension_removal", "issue_resolved", "paid"];
const CURRENT_PAST: Past[] = ["pending_review", "ready_to_send", "approved_unsent", "sent", "paid", "paid_on_spot_sent", "unbilled", "returned", "no_show", "late_cancel", "payment_issue", "batched"];
const CURRENT_FUTURE: Future[] = ["open", "filled", "backup", "pending_short", "flexible", "officer_safety", "vendor_on_hold", "held", "requested", "reactivated", "declined", "active"];
const FUTURE_MONTH: Future[] = ["open", "filled", "backup", "pending_short", "flexible", "officer_safety", "vendor_on_hold", "held", "open", "requested", "reactivated", "ops_plan_due", "filled", "open"];

export function buildDemoData(today: Date): DemoData {
  const d: DemoData = {
    vendorTypes: VENDOR_TYPES.map((name, i) => ({ id: uuidv7(), name, sortOrder: i + 1 })),
    users: [],
    vendors: [],
    vendorLocations: [],
    vendorContacts: [],
    vendorUsers: [],
    vendorHolds: [],
    jobs: [],
    jobPositions: [],
    jobSafety: [],
    jobSafetyAddresses: [],
    assignments: [],
    invoiceBatches: [],
    invoices: [],
    paymentIssues: [],
    paymentIssueNotes: [],
    opsPlans: [],
    audit: [],
    settings: {},
  };
  const created = new Date(today.getTime() - 400 * DAY);

  // People.
  const person = (name: string, email: string, role: DemoUser["role"], rank: RankName | null, n: number, extra: Partial<DemoUser> = {}): DemoUser => {
    const u: DemoUser = {
      id: uuidv7(),
      name,
      email,
      emailVerified: true,
      role,
      rank,
      qualifications: [],
      phone: phone(n),
      badgeNumber: role === "personnel" ? `B${1000 + n}` : null,
      mailingAddress: role === "personnel" ? `${100 + n} ${STREETS[n % STREETS.length]}, Bayside, FL 32400` : null,
      lastSignInAt: new Date(today.getTime() - (n % 9) * DAY),
      createdAt: created,
      ...extra,
    };
    d.users.push(u);
    return u;
  };
  const practiceDeputy = person("Riley Practice", PRACTICE_USER_EMAILS.deputy, "personnel", "Deputy Sheriff", 1, { qualifications: ["Incident Commander"] });
  const coordinator = person("Casey Practice", PRACTICE_USER_EMAILS.coordinator, "coordinator", null, 2);
  person("Alex Practice", PRACTICE_USER_EMAILS.admin, "admin", null, 3);
  const vendorUser = person("Vic Practice", PRACTICE_USER_EMAILS.vendor, "vendor", null, 4);
  const coordinator2 = person("Dana Holloway", "dana.holloway@training.example", "coordinator", null, 5);

  const rankPlan: RankName[] = [...new Array(15).fill("Deputy Sheriff"), ...new Array(8).fill("CSO"), ...new Array(6).fill("Posse"), ...new Array(2).fill("Dispatcher")];
  const personnel: DemoUser[] = [practiceDeputy];
  rankPlan.forEach((rank, i) => {
    const name = `${FIRST[i % FIRST.length]} ${LAST[(i * 7) % LAST.length]}`;
    const email = `${slug(name).replace("-", ".")}@training.example`;
    personnel.push(person(name, email, "personnel", rank, 10 + i, { qualifications: rank === "Deputy Sheriff" && i < 4 ? ["Incident Commander"] : [] }));
  });
  const suspended = personnel.at(-5)!; // a Posse member
  suspended.suspensionReason = "Administrative review";
  suspended.suspendedUntil = new Date(today.getTime() + 20 * DAY);

  // Vendors, each with a location and site contacts; one on payment hold, one batched weekly, one approve-only.
  const BATCHED_VENDORS: Partial<Record<number, "weekly" | "monthly">> = { 4: "weekly", 7: "monthly" };
  VENDOR_NAMES.forEach((name, i) => {
    const id = uuidv7();
    d.vendors.push({
      id,
      name,
      typeId: d.vendorTypes[i % VENDOR_TYPES.length].id,
      contactName: `${FIRST[(i + 5) % FIRST.length]} ${LAST[(i + 11) % LAST.length]}`,
      phone: phone(200 + i),
      billingEmails: [`ap@${slug(name)}.example`],
      defaultRateCents: 5000 + (i % 5) * 500,
      paymentHold: i === 2,
      paymentHoldReason: i === 2 ? "Invoices more than 90 days unpaid" : null,
      invoiceSendSchedule: BATCHED_VENDORS[i] ?? null,
      emailApprovedInvoices: i !== 5,
      createdAt: created,
    });
    for (let l = 0; l < (i % 3 === 0 ? 2 : 1); l++) {
      d.vendorLocations.push({
        id: uuidv7(),
        vendorId: id,
        name: l === 0 ? "Main site" : "Overflow lot",
        address: `${200 + i * 10 + l} ${STREETS[(i + l) % STREETS.length]}, Bayside, FL 32400`,
        lat: 29.36 + (i % 7) * 0.012 + l * 0.003,
        lng: -82.25 + (i % 5) * 0.03 + l * 0.003,
        geocodeSource: "manual",
        createdAt: created,
      });
    }
    for (let c = 0; c < (i % 2 === 0 ? 2 : 1); c++) {
      d.vendorContacts.push({
        id: uuidv7(),
        vendorId: id,
        name: c === 0 ? `${FIRST[(i + 9) % FIRST.length]} ${LAST[(i + 3) % LAST.length]}` : `${FIRST[(i + 17) % FIRST.length]} ${LAST[(i + 21) % LAST.length]}`,
        phone: phone(300 + i * 2 + c),
        email: `${c === 0 ? "site" : "security"}@${slug(name)}.example`,
        notes: c === 0 ? "Meets deputies at the main gate." : null,
      });
    }
  });
  d.vendorUsers.push({ userId: vendorUser.id, vendorId: d.vendors[0].id });
  d.vendorHolds.push({ vendorId: d.vendors[2].id, placedBy: coordinator.id, placedAt: new Date(today.getTime() - 30 * DAY), reason: "Invoices more than 90 days unpaid" });

  const heldVendor = d.vendors[2];
  const batchVendor = d.vendors[4];
  const regular = d.vendors.filter((v) => v !== heldVendor && v !== batchVendor);
  const location = (vendorId: string) => d.vendorLocations.find((l) => l.vendorId === vendorId)!;
  const contact = (vendorId: string) => d.vendorContacts.find((c) => c.vendorId === vendorId)!;

  // Deputies by what they can fill; rotation keeps the work spread out.
  const pools: Record<PositionName, DemoUser[]> = {
    "Deputy Sheriff": personnel.filter((u) => u.rank === "Deputy Sheriff" && u !== practiceDeputy),
    CSO: personnel.filter((u) => u.rank === "CSO" || u.rank === "Deputy Sheriff").filter((u) => u !== practiceDeputy),
    Posse: personnel.filter((u) => u.rank === "Posse" && u !== suspended),
    "Incident Commander": personnel.filter((u) => u.qualifications.includes("Incident Commander") && u !== practiceDeputy),
    Dispatcher: personnel.filter((u) => u.rank === "Dispatcher"),
  };
  const turn: Record<string, number> = {};
  const pick = (pos: PositionName, taken: Set<string>): DemoUser => {
    const pool = pools[pos];
    for (let k = 0; k < pool.length; k++) {
      turn[pos] = ((turn[pos] ?? -1) + 1) % pool.length;
      const u = pool[turn[pos]];
      if (!taken.has(u.id)) return u;
    }
    throw new Error(`No one left for ${pos}`);
  };

  // Time: agency wall clock relative to today.
  const base = agencyDateParts(today);
  const at = (monthOffset: number, day: number, hour: number) => agencyInstant(base.year, base.month + monthOffset, day, hour, 0);
  const daysInMonth = new Date(Date.UTC(base.year, base.month, 0)).getUTCDate();

  let serial = 0;
  type Built = { job: DemoJob; positions: DemoPosition[]; taken: Set<string> };

  function job(start: Date, hours: number, opts: { vendor?: (typeof d.vendors)[number]; title?: string; positions: Array<[PositionName, number]>; extra?: Partial<DemoJob> }): Built {
    const n = serial++;
    const vendor = opts.vendor ?? (n % 4 === 0 ? d.vendors[0] : regular[n % regular.length]);
    const types = ["Basic Security", "Traffic Control", "County Permitted Event"];
    const end = new Date(start.getTime() + hours * HOUR);
    const c = contact(vendor.id);
    const j: DemoJob = {
      id: uuidv7(),
      vendorId: vendor.id,
      locationId: location(vendor.id).id,
      type: types[n % types.length],
      title: opts.title ?? `${vendor.name} ${["security", "traffic", "event"][n % 3]}`,
      description: "Demo detail for training.",
      startAt: start,
      endAt: end,
      rateCents: vendor.defaultRateCents ?? 5500,
      contactName: c.name,
      contactPhone: c.phone,
      state: "scheduled",
      held: false,
      releaseAt: releaseAt(start, DEFAULT_SETTINGS),
      createdAt: new Date(Math.min(start.getTime() - 45 * DAY, today.getTime() - DAY)),
      ...opts.extra,
    };
    d.jobs.push(j);
    const positions = opts.positions.map(([positionType, count]) => {
      const p: DemoPosition = { id: uuidv7(), jobId: j.id, positionType, count, rateDifferentialCents: positionType === "Incident Commander" ? 2500 : 0 };
      d.jobPositions.push(p);
      return p;
    });
    return { job: j, positions, taken: new Set() };
  }

  function assign(b: Built, posIndex: number, status: Ins<typeof assignments>["status"], who?: DemoUser, extra: Partial<Ins<typeof assignments>> = {}) {
    const pos = b.positions[posIndex];
    const u = who ?? pick(pos.positionType, b.taken);
    b.taken.add(u.id);
    const worked = status === "billed" || status === "paid" || status === "no_show";
    const a = {
      id: uuidv7(),
      jobId: b.job.id,
      jobPositionId: pos.id,
      userId: u.id,
      status,
      requestedAt: new Date(Math.min(b.job.startAt.getTime() - 20 * DAY, today.getTime() - HOUR)),
      warningVersion: "1",
      warningAcceptedAt: new Date(Math.min(b.job.startAt.getTime() - 20 * DAY, today.getTime() - HOUR)),
      isIncidentCommander: pos.positionType === "Incident Commander",
      ...(worked && status !== "no_show" ? { actualStartAt: b.job.startAt, actualEndAt: b.job.endAt, billedAt: new Date(b.job.endAt.getTime() + HOUR) } : {}),
      ...extra,
    };
    d.assignments.push(a);
    return { a, u, pos };
  }

  function invoice(b: Built, x: ReturnType<typeof assign>, status: DemoInvoice["status"], extra: Partial<DemoInvoice> = {}): DemoInvoice {
    const minutes = extra.minutes ?? Math.round((b.job.endAt.getTime() - b.job.startAt.getTime()) / 60_000);
    const rateCents = b.job.rateCents + (x.pos.rateDifferentialCents ?? 0);
    const end = b.job.endAt.getTime();
    const sent = status === "sent" || status === "paid" || status === "written_off";
    const inv: DemoInvoice = {
      id: uuidv7(),
      assignmentId: x.a.id,
      vendorId: b.job.vendorId,
      payeeUserId: x.u.id,
      minutes,
      rateCents,
      totalCents: Math.round((minutes * rateCents) / 60),
      status,
      emailStatus: sent ? "sent" : "not_queued",
      sentAt: sent ? new Date(end + DAY) : null,
      readyAt: status === "ready_to_send" ? new Date(end + 2 * HOUR) : null,
      responsibleParty: status === "sent" ? "vendor" : null,
      responsibleSince: status === "sent" ? new Date(end + DAY) : null,
      createdAt: new Date(end + HOUR),
      ...(status === "paid" ? { vendorPaidAt: new Date(end + 10 * DAY), vendorMethod: "Check mailed", deputyPaidAt: new Date(end + 12 * DAY), deputyMethod: "Check handed to deputy" } : {}),
      ...extra,
    };
    // Nothing is billed before the detail ends; any instant here stays at or before today.
    for (const k of ["sentAt", "vendorPaidAt", "deputyPaidAt", "readyAt"] as const) {
      const v = inv[k];
      if (v instanceof Date && v > today) inv[k] = new Date(Math.max(end, today.getTime() - 60_000));
    }
    d.invoices.push(inv);
    if (x.a.status === "billed" && status === "paid") x.a.status = "paid";
    return inv;
  }

  const worked = (b: Built, pos: number, status: DemoInvoice["status"], who?: DemoUser, extra: Partial<DemoInvoice> = {}) =>
    invoice(b, assign(b, pos, status === "paid" ? "paid" : "billed", who), status, extra);

  function past(kind: Past, start: Date, withPractice: boolean) {
    const me = withPractice ? practiceDeputy : undefined;
    switch (kind) {
      case "paid":
        return worked(job(start, 4, { positions: [["Deputy Sheriff", 1]] }), 0, "paid", me);
      case "paid_two": {
        const b = job(start, 5, { positions: [["Deputy Sheriff", 1], ["CSO", 1]] });
        worked(b, 0, "paid", me);
        return worked(b, 1, "paid");
      }
      case "sent":
        return worked(job(start, 4, { positions: [["CSO", 1]] }), 0, "sent", me);
      case "paid_on_spot_sent": {
        // Paid to the deputy on the spot, closed as paid, then sent to the vendor marked Paid.
        const b = job(start, 4, { positions: [["Deputy Sheriff", 1]] });
        const end = b.job.endAt.getTime();
        return worked(b, 0, "paid", me, { deputyPaidAt: b.job.endAt, deputyMethod: "Cash", vendorPaidAt: b.job.endAt, vendorMethod: "Cash", sentAt: new Date(end + 2 * HOUR), emailStatus: "sent" });
      }
      case "written_off":
        return worked(job(start, 4, { positions: [["Posse", 1]] }), 0, "written_off", undefined, { closedReason: "Vendor went out of business" });
      case "payment_issue":
      case "issue_resolved": {
        const b = job(start, 4, { positions: [["Deputy Sheriff", 1]] });
        const inv = worked(b, 0, kind === "payment_issue" ? "sent" : "paid", me);
        const id = uuidv7();
        const opened = new Date(Math.min(b.job.endAt.getTime() + 35 * DAY, today.getTime() - HOUR));
        d.paymentIssues.push({
          id,
          invoiceId: inv.id,
          openedBy: inv.payeeUserId,
          note: "Vendor has not paid after repeated requests",
          status: kind === "payment_issue" ? "open" : "paid",
          waitingOn: kind === "payment_issue" ? "vendor" : null,
          closedAt: kind === "payment_issue" ? null : new Date(Math.min(opened.getTime() + 5 * DAY, today.getTime() - 60_000)),
          createdAt: opened,
        });
        d.paymentIssueNotes.push({ issueId: id, authorUserId: coordinator.id, note: "Called vendor, left message", visibility: "deputy", createdAt: opened });
        return inv;
      }
      case "late_cancel": {
        // Two deputies get late-cancel pay: one billed it (the assignment moves to billed), one has not yet.
        const b = job(start, 4, { positions: [["Deputy Sheriff", 2]], extra: { state: "canceled", canceledByVendor: true, canceledAt: new Date(start.getTime() - 3 * HOUR), cancelReason: "Event called off by the vendor" } });
        const x = assign(b, 0, "billed", me, { billedAt: new Date(b.job.endAt.getTime() + HOUR) });
        assign(b, 0, "late_canceled");
        return invoice(b, x, "sent", { kind: "late_cancel", minutes: DEFAULT_SETTINGS.minimumBillableMinutes });
      }
      case "no_show": {
        const b = job(start, 4, { positions: [["Deputy Sheriff", 1], ["CSO", 1]] });
        worked(b, 0, "sent");
        return assign(b, 1, "no_show");
      }
      case "ops_plan_agreed": {
        const b = job(start, 6, { title: "Harbor Fest crowd control", positions: [["Incident Commander", 1], ["Deputy Sheriff", 2]], extra: { opsPlanRequired: true, opsPlanDueAt: new Date(start.getTime() - 3 * DAY) } });
        const ic = assign(b, 0, "paid", me?.qualifications.includes("Incident Commander") ? me : undefined);
        invoice(b, ic, "paid");
        worked(b, 1, "paid");
        d.opsPlans.push({
          id: uuidv7(),
          jobId: b.job.id,
          vendorId: b.job.vendorId,
          eventName: b.job.title,
          year: agencyDateParts(start).year,
          location: location(b.job.vendorId).address,
          status: "agreed",
          version: { submittedBy: ic.u.id, submittedAt: new Date(start.getTime() - 5 * DAY), decision: "agreed", decidedBy: coordinator.id, decidedAt: new Date(start.getTime() - 4 * DAY) },
        });
        return b;
      }
      case "canceled_early": {
        const b = job(start, 4, { positions: [["CSO", 2]], extra: { state: "canceled", canceledAt: new Date(start.getTime() - 6 * DAY), cancelReason: "Vendor rescheduled the event" } });
        assign(b, 0, "canceled");
        return assign(b, 0, "canceled");
      }
      case "batched": {
        const b = job(start, 4, { vendor: batchVendor, positions: [["Deputy Sheriff", 1], ["CSO", 1]] });
        const sentAt = new Date(Math.min(b.job.endAt.getTime() + 3 * DAY, today.getTime() - 60_000));
        const batchId = uuidv7();
        d.invoiceBatches.push({ id: batchId, vendorId: batchVendor.id, sentBy: coordinator.id, sentAt, emailStatus: "sent", attachW9ForAll: false });
        worked(b, 0, "sent", me, { batchId, sentAt, responsibleSince: sentAt });
        return worked(b, 1, "sent", undefined, { batchId, sentAt, responsibleSince: sentAt });
      }
      case "returned":
        return worked(job(start, 4, { positions: [["CSO", 1]] }), 0, "returned");
      case "suspension_removal": {
        const b = job(start, 4, { positions: [["Posse", 1]] });
        assign(b, 0, "removed", suspended, { removalReason: "Suspended" });
        return worked(b, 0, "paid");
      }
      case "unbilled":
        // Worked, not billed yet: the deputy's "Bill this detail" example.
        return assign(job(start, 4, { positions: [["Deputy Sheriff", 1]] }), 0, "signed_up", me);
      case "pending_review":
        return worked(job(start, 4, { positions: [["Deputy Sheriff", 1]] }), 0, "pending_review", me);
      case "ready_to_send":
        return worked(job(start, 4, { vendor: batchVendor, positions: [["CSO", 1]] }), 0, "ready_to_send");
      case "approved_unsent":
        return worked(job(start, 4, { vendor: d.vendors[5], positions: [["Deputy Sheriff", 1]] }), 0, "approved_unsent");
    }
  }

  function future(kind: Future, start: Date, withPractice: boolean) {
    const me = withPractice ? practiceDeputy : undefined;
    switch (kind) {
      case "open": {
        const b = job(start, 4, { positions: [["Deputy Sheriff", 3]] });
        return assign(b, 0, "signed_up", me);
      }
      case "filled": {
        const b = job(start, 5, { positions: [["CSO", 2]] });
        assign(b, 0, "signed_up");
        return assign(b, 0, "signed_up");
      }
      case "backup": {
        const b = job(start, 4, { positions: [["Deputy Sheriff", 1]] });
        assign(b, 0, "signed_up");
        assign(b, 0, "backup", me, { backupPosition: 1 });
        return assign(b, 0, "backup", undefined, { backupPosition: me ? 2 : 1 });
      }
      case "pending_short": {
        const b = job(start, 8, { positions: [["Deputy Sheriff", 2]], extra: { flexEarliestStartAt: start, flexLatestEndAt: new Date(start.getTime() + 8 * HOUR), flexAllowShorter: true } });
        assign(b, 0, "signed_up");
        return assign(b, 0, "pending_short", undefined, { plannedStartAt: start, plannedEndAt: new Date(start.getTime() + 4 * HOUR) });
      }
      case "flexible": {
        const b = job(start, 4, { positions: [["CSO", 1]], extra: { flexEarliestStartAt: new Date(start.getTime() - 2 * HOUR), flexLatestEndAt: new Date(start.getTime() + 6 * HOUR) } });
        return assign(b, 0, "signed_up", me);
      }
      case "officer_safety": {
        const b = job(start, 4, { positions: [["Deputy Sheriff", 2]] });
        d.jobSafety.push({ jobId: b.job.id, notes: "Known disturbance history at the east lot. Park facing out.", addedBy: coordinator.id, addedAt: new Date(today.getTime() - 2 * DAY) });
        d.jobSafetyAddresses.push({ jobId: b.job.id, address: "418 Live Oak Ln, Bayside, FL 32400", description: "Prior weapons call", lat: 29.371, lng: -82.231, geocodeSource: "manual", addedBy: coordinator.id });
        return assign(b, 0, "signed_up");
      }
      case "vendor_on_hold": {
        const b = job(start, 4, { vendor: heldVendor, positions: [["CSO", 1]] });
        return assign(b, 0, "signed_up");
      }
      case "held":
        return job(start, 4, { positions: [["Posse", 2]], extra: { held: true } });
      case "requested":
        return job(start, 4, { vendor: d.vendors[0], title: "Requested: parking lot patrol", positions: [["Deputy Sheriff", 1]], extra: { state: "requested", requestedByUserId: vendorUser.id } });
      case "declined":
        return job(start, 3, { vendor: d.vendors[0], title: "Requested: late-night valet watch", positions: [["CSO", 1]], extra: { state: "declined", cancelReason: "Not enough notice" } });
      case "active": {
        const b = job(start, 4, { positions: [["Dispatcher", 1]], extra: { state: "active" } });
        return assign(b, 0, "signed_up");
      }
      case "reactivated": {
        // Canceled, then brought back with an empty roster; the history shows both.
        const b = job(start, 4, { positions: [["Deputy Sheriff", 2]] });
        assign(b, 0, "canceled", undefined, { removalReason: "Detail canceled" });
        assign(b, 0, "canceled", undefined, { removalReason: "Detail canceled" });
        const canceledAt = new Date(today.getTime() - 5 * DAY);
        d.audit.push({ action: "job.cancel", entityType: "job", entityId: b.job.id, actorUserId: coordinator2.id, at: canceledAt, reason: "Vendor asked to cancel", before: { state: "scheduled" }, after: { state: "canceled" } });
        d.audit.push({ action: "job.reactivate", entityType: "job", entityId: b.job.id, actorUserId: coordinator.id, at: new Date(canceledAt.getTime() + DAY), reason: "Vendor confirmed the event is back on", before: { state: "canceled" }, after: { state: "scheduled" } });
        return b;
      }
      case "ops_plan_due": {
        const b = job(start, 6, { title: "Fireworks over the bay", positions: [["Incident Commander", 1], ["Deputy Sheriff", 2]], extra: { opsPlanRequired: true, opsPlanDueAt: new Date(start.getTime() - 3 * DAY) } });
        // The practice deputy (an Incident Commander) always leads it, so a deputy in training can submit the plan.
        const ic = assign(b, 0, "signed_up", practiceDeputy);
        d.opsPlans.push({ id: uuidv7(), jobId: b.job.id, vendorId: b.job.vendorId, eventName: b.job.title, year: agencyDateParts(start).year, location: location(b.job.vendorId).address, status: "due", version: null });
        return ic;
      }
    }
  }

  const hourFor = (i: number) => [8, 13, 18][i % 3];
  // The 12 past months.
  for (let m = -12; m <= -1; m++) {
    PAST_MONTH.forEach((kind, i) => {
      const k: Past = m === -1 && kind === "paid" ? "unbilled" : kind;
      past(k, at(m, 1 + 2 * i, hourFor(i)), i % 3 === 0);
    });
  }
  // This month: what has already happened (on earlier days), then what is still to come.
  const before = base.day - 1;
  CURRENT_PAST.forEach((kind, i) => {
    // On the 1st there is no earlier day this month; these land on the last days of last month instead.
    const day = before > 0 ? base.day - 1 - (i % before) : -(i % 10);
    past(kind, at(0, day, 8), kind === "unbilled" || i % 3 === 0);
  });
  const after = daysInMonth - base.day;
  CURRENT_FUTURE.forEach((kind, i) => {
    // On the last day there is no later day this month; these land early next month instead.
    const day = after > 0 ? base.day + 1 + (i % after) : daysInMonth + 1 + (i % 10);
    future(kind, at(0, day, hourFor(i)), i % 4 === 0);
  });
  // The next 3 months.
  for (let m = 1; m <= 3; m++) {
    FUTURE_MONTH.forEach((kind, i) => future(kind, at(m, 1 + 2 * i, hourFor(i)), i % 3 === 0));
  }

  d.settings = {
    agency: {
      ...DEFAULT_SETTINGS.agency,
      name: "Bayside County Sheriff's Office",
      sheriffName: "Sheriff Jordan Example",
      address: "100 Example Way, Bayside, FL 32400",
      phone: "850-555-0100",
      email: "office@training.example",
      website: "https://bayside.example",
    },
    billingReplyToEmail: "billing@training.example",
    agencyDefaultRateCents: 5500,
    rateMinCents: 4000,
    rateMaxCents: 9500,
    // The agency switched push off for detail changes to deputies, and email off for new messages to staff.
    notificationChannels: { "job.changed": { personnel: { push: false } }, "message.received": { staff: { email: false } } },
  };
  return d;
}

/**
 * Writes `data` into a database that has the built-in seed. The ops plan files go to the current mode's storage
 * (training storage in training mode). One transaction.
 */
export async function loadDemoData(tx: Tx, data: DemoData): Promise<void> {
  const rankId = new Map((await tx.select().from(ranks)).map((r) => [r.name, r.id]));
  const qualId = new Map((await tx.select().from(qualifications)).map((q) => [q.name, q.id]));
  const typeId = new Map((await tx.select().from(jobTypes)).map((t) => [t.name, t.id]));
  const positionId = new Map((await tx.select().from(positionTypes)).map((p) => [p.name, p.id]));
  const methodId = new Map((await tx.select().from(paymentMethods)).map((m) => [m.name, m.id]));
  const need = <T>(m: Map<string, T>, k: string, what: string): T => {
    const v = m.get(k);
    if (v === undefined) throw new Error(`The built-in seed has no ${what} "${k}". Run the seed first.`);
    return v;
  };
  const chunks = async <T>(rows: T[], insert: (part: T[]) => Promise<unknown>) => {
    // Sequential: the chunks are inserted in one transaction, in order.
    for (let i = 0; i < rows.length; i += 500) await insert(rows.slice(i, i + 500));
  };

  await tx.insert(vendorTypes).values(data.vendorTypes).onConflictDoNothing({ target: vendorTypes.name });
  await chunks(
    // Only the users table's columns are written; rank and qualifications are resolved separately.
    data.users.map((u) => ({ ...u, rankId: u.rank ? need(rankId, u.rank, "rank") : null })),
    (part) => tx.insert(users).values(part),
  );
  const quals = data.users.flatMap((u) => u.qualifications.map((q) => ({ userId: u.id, qualificationId: need(qualId, q, "qualification") })));
  if (quals.length) await tx.insert(userQualifications).values(quals);
  await tx.insert(vendors).values(data.vendors);
  await tx.insert(vendorLocations).values(data.vendorLocations);
  await tx.insert(vendorContacts).values(data.vendorContacts);
  await tx.insert(vendorUsers).values(data.vendorUsers);
  await tx.insert(vendorHolds).values(data.vendorHolds);
  // Detail numbers follow start dates, as if they had been created over the year.
  const ordered = [...data.jobs].sort((a, b) => a.startAt.getTime() - b.startAt.getTime());
  await chunks(
    ordered.map(({ type, ...j }) => ({ ...j, typeId: need(typeId, type, "detail type") })),
    (part) => tx.insert(jobs).values(part),
  );
  await chunks(
    data.jobPositions.map(({ positionType, ...p }) => ({ ...p, positionTypeId: need(positionId, positionType, "position type") })),
    (part) => tx.insert(jobPositions).values(part),
  );
  if (data.jobSafety.length) await tx.insert(jobSafety).values(data.jobSafety);
  if (data.jobSafetyAddresses.length) await tx.insert(jobSafetyAddresses).values(data.jobSafetyAddresses);
  await chunks(data.assignments, (part) => tx.insert(assignments).values(part));
  if (data.invoiceBatches.length) await tx.insert(invoiceBatches).values(data.invoiceBatches);
  const invoiceRows = [...data.invoices]
    .sort((a, b) => (a.createdAt as Date).getTime() - (b.createdAt as Date).getTime())
    .map(({ deputyMethod, vendorMethod, ...i }) => ({
      ...i,
      deputyMethodId: deputyMethod ? need(methodId, deputyMethod, "payment method") : null,
      vendorPaidMethodId: vendorMethod ? need(methodId, vendorMethod, "payment method") : null,
    }));
  await chunks(invoiceRows, (part) => tx.insert(invoices).values(part));
  if (data.paymentIssues.length) await tx.insert(paymentIssues).values(data.paymentIssues);
  if (data.paymentIssueNotes.length) await tx.insert(paymentIssueNotes).values(data.paymentIssueNotes);
  // Sequential: each plan and its file are written in this transaction, the version after its plan.
  for (const { version, ...plan } of data.opsPlans) {
    await tx.insert(opsPlans).values(plan);
    if (!version) continue;
    const file = await storeFile("system", tx, { kind: "ops_plan", filename: `${plan.eventName} ops plan.pdf`, contentType: "application/pdf", body: DEMO_PDF }, { only: "pdf" });
    await tx.insert(opsPlanVersions).values({ opsPlanId: plan.id, fileId: file.id, ...version });
  }
  if (data.audit.length) await tx.insert(auditLog).values(data.audit.map((a) => ({ ...a, reason: a.reason ?? null, before: a.before ?? null, after: a.after ?? null })));
  const [row] = await tx.select({ id: settingsTable.id }).from(settingsTable).limit(1);
  if (row) await tx.update(settingsTable).set({ value: data.settings }).where(eq(settingsTable.id, row.id));
  else await tx.insert(settingsTable).values({ value: data.settings });
}

/** The built-in seed, then the demo data for `today`, on `db`. Run it in the mode whose storage should hold the files. */
export async function seedDemo(db: Db, today: Date = new Date()): Promise<void> {
  await seed(db);
  await db.transaction((tx) => loadDemoData(tx, buildDemoData(today)));
}

