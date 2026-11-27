import { z } from "zod";
import { agencyDate } from "./dates";

/**
 * Every /api/v1 route: its method, path, summary and Zod schemas. Each route file passes its entry to apiHandler,
 * and the OpenAPI document at /api/v1/openapi.json is built from this list, so the two cannot drift apart (a test
 * scans the route files against it).
 */
type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export type RouteDef = {
  method: Method;
  /** Under /api/v1, with `{name}` for path parameters. */
  path: string;
  summary: string;
  description?: string;
  tag?: string;
  /** JSON body. */
  body?: z.ZodType;
  /** Multipart fields (name to description); the route reads the form itself, within the upload limit. */
  form?: Record<string, string>;
  query?: z.ZodType;
  /** The `data` of a JSON answer, or a file (see `file`). */
  response: z.ZodType;
  status?: 200 | 201;
  /** No sign-in needed. */
  public?: true;
  /** A read sent as POST (it changes nothing): an API key needs only the read scope. */
  readOnly?: true;
  /** A W-9 file: an API key also needs the w9 scope. */
  w9?: true;
  /** A file read: someone else's file answers 404, not 403, so ids cannot be probed. */
  hideForbidden?: true;
};

type Spec = Omit<RouteDef, "method" | "path">;
type Keyed<T extends Record<string, Spec>> = {
  [K in keyof T]: T[K] & (K extends `${infer M extends Method} ${infer P}` ? { method: M; path: P } : never);
};

function define<const T extends Record<string, Spec>>(specs: T): Keyed<T> {
  const out: Record<string, RouteDef> = {};
  for (const [key, spec] of Object.entries(specs)) {
    const [method, path] = key.split(" ") as [Method, string];
    out[key] = { ...spec, method, path };
  }
  return out as Keyed<T>;
}

// Building blocks

/** A file answer. The OpenAPI document shows it as a download of this type. */
const file = (contentType: string, description: string) => z.custom<Uint8Array>().meta({ file: contentType, description });
export function fileType(schema: z.ZodType): string | null {
  const meta = z.globalRegistry.get(schema) as { file?: string } | undefined;
  return meta?.file ?? null;
}

const record = (description: string) => z.object({ id: z.string() }).loose().meta({ description });
const list = (description: string) => z.array(record(description));
const ok = z.object({ ok: z.literal(true) });
const anything = (description: string) => z.unknown().meta({ description });
const csv = z
  .string()
  .transform((s) => s.split(",").filter(Boolean))
  .meta({ description: "Comma-separated list." });
const bool = z.enum(["true", "false"]).transform((v) => v === "true");
const page = z.coerce.number().int().min(1).meta({ description: "1-based page number." });
const text = z.string();
const optText = z.string().nullable().optional();
const ids = z.array(z.string());

const safety = z
  .object({
    notes: z.string(),
    addresses: z.array(z.object({ address: z.string(), description: z.string(), lat: z.number().nullable().optional(), lng: z.number().nullable().optional() }).loose()),
  })
  .loose();

const jobBody = z
  .object({
    vendorId: text,
    locationId: z.string().nullable(),
    typeId: text,
    title: text,
    description: optText,
    notes: optText,
    startAt: text.meta({ description: "ISO 8601 timestamp." }),
    endAt: text.meta({ description: "ISO 8601 timestamp." }),
    rateCents: z.number().int().nullable(),
    positions: z.array(z.object({ positionTypeId: text, count: z.number().int() }).loose()),
    opsPlanRequired: z.boolean(),
    opsPlanDueAt: z.string().nullable(),
    contactName: optText,
    contactPhone: optText,
    held: z.boolean(),
    flex: z.object({ earliestStartAt: text, latestEndAt: text, allowShorter: z.boolean() }).nullable(),
    safety,
    rateOverrideReason: optText,
    conflictOverride: z.object({ reason: text, fingerprint: text }).nullable(),
  })
  .partial()
  .loose();

/** A payment: a date-only paid date is agency midnight, so cash-basis year boundaries hold. */
const payment = z.object({
  paymentMethodId: z.string().min(1, "Choose a payment method."),
  reference: z.string().default(""),
  paidAt: agencyDate("start"),
  note: z.string().optional(),
});
/** A last day with the agency: an agency date, today or earlier. */
const lastDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Enter the last day as a date (YYYY-MM-DD).").meta({ description: "The last day with the agency (YYYY-MM-DD, an agency day), today or earlier." });
/** The departure checklist; `signups` names its first list ("upcoming" in a preview, "removed" after deactivation). */
const departureLists = <K extends string>(signups: K) =>
  z.object({
    [signups]: z.array(z.object({ assignmentId: text, status: text, jobId: text, jobNumber: z.number(), title: text, vendorName: text, position: text, startAt: text, endAt: text }).loose()),
    unbilled: z.array(z.object({ assignmentId: text, jobId: text, jobNumber: z.number(), title: text, vendorName: text, startAt: text, endAt: text, lateCancel: z.boolean() }).loose()),
    unpaid: z.array(z.object({ invoiceId: text, number: text, jobId: text, status: text, totalCents: z.number().int() }).loose()),
  } as Record<K | "unbilled" | "unpaid", z.ZodType>);
const reportSpec = z.object({ spec: anything("A report spec (dataset, groupBy, measures, filters, from, to). Date-only from and to are agency days.") }).loose();
/** A report period: a date-only From is the start of that agency day and a date-only To is its end. */
const period = z.object({ from: agencyDate("start").optional(), to: agencyDate("end").optional() });
const vendorBody = z
  .object({
    name: text,
    typeId: z.string().nullable(),
    contactName: optText,
    phone: optText,
    billingEmails: z.array(z.string()),
    defaultRateCents: z.number().int().nullable(),
    notes: optText,
    invoiceSendSchedule: z.enum(["immediate", "weekly", "every_2_weeks", "monthly"]).nullable(),
    emailApprovedInvoices: z.boolean(),
    requiresCurrentYearW9: z.boolean(),
  })
  .partial()
  .loose();
/** Creating a vendor: a name; everything else may be left out. */
const vendorCreate = z
  .object({
    name: text,
    typeId: z.string().nullable().default(null),
    contactName: z.string().nullable().default(null),
    phone: z.string().nullable().default(null),
    billingEmails: z.array(z.string()).default([]),
    defaultRateCents: z.number().int().nullable().default(null),
    notes: z.string().nullable().default(null),
    invoiceSendSchedule: z.enum(["immediate", "weekly", "every_2_weeks", "monthly"]).nullable().optional(),
  })
  .loose();
const pin = z.object({ lat: z.number(), lng: z.number(), source: z.enum(["auto", "manual"]) });
const locationBody = z.object({ name: text, address: z.string().nullable(), notes: optText, pin: pin.nullable().optional() }).partial().loose();
const locationCreate = z.object({ name: text, address: z.string().nullable().default(null), notes: optText, pin: pin.nullable().optional() }).loose();
const audience = z.union([
  z.object({ kind: z.literal("all") }),
  z.object({ kind: z.literal("users"), userIds: ids }),
  z.object({ kind: z.literal("rank"), rankIds: ids }),
  z.object({ kind: z.literal("job"), jobId: text }),
  z.object({ kind: z.literal("coordinators") }),
]);

export const routes = define({
  // API description and full data access
  "GET /openapi.json": { tag: "API", summary: "This OpenAPI document", public: true, response: anything("OpenAPI 3.1 document.") },
  "GET /data/{entity}": {
    tag: "Data",
    summary: "Read every record of a table",
    description:
      "Admins and API keys with read scope. Rows are ordered by id. Use `limit` (1 to 500, default 100) and pass `nextCursor` back as `cursor` for the next page. `updatedSince` keeps rows changed at or after that instant (a date-only value is agency midnight). Any other query parameter is an equality filter on a column (camelCase name). Secret columns (key and token hashes, encrypted links, push keys, storage keys) are never returned.",
    query: z
      .object({
        updatedSince: agencyDate("start").optional(),
        cursor: z.string().optional(),
        limit: z.coerce.number().int().min(1).max(500).optional(),
      })
      .catchall(z.string()),
    response: z.array(record("A row.")),
  },
  "GET /export": {
    tag: "Data",
    summary: "Export every table as a zip",
    description: "Admins and API keys with read scope. A zip with one JSON or CSV file per table, streamed. W-9 and other files are listed by id in the files table, not included.",
    query: z.object({ format: z.enum(["json", "csv"]) }),
    response: file("application/zip", "A zip of every table."),
  },

  // Agency
  "GET /agency/logo": { tag: "Agency", summary: "The agency logo (PNG)", public: true, response: file("image/png", "The logo.") },
  "POST /agency/logo": { tag: "Agency", summary: "Upload the agency logo", form: { logo: "PNG, SVG, JPG or WebP, up to 2 MB." }, response: z.object({ message: text }) },
  "GET /agency/notifications": {
    tag: "Agency",
    summary: "The agency's notification switches",
    description: "Coordinators and admins. `channels` maps a notification type to a recipient group (vendor, personnel, staff) to `{ email, push }`; anything missing is on.",
    response: z.object({ channels: anything("Type, then group, then channel.") }),
  },
  "PATCH /agency/notifications": {
    tag: "Agency",
    summary: "Turn notification switches on or off",
    description: "Coordinators and admins. Only the switches sent change. Locked types (sign-in codes, invitations, password reset, the invoice to the vendor, the test email) cannot be turned off.",
    body: z.object({ channels: z.record(z.string(), z.record(z.string(), z.object({ email: z.boolean().optional(), push: z.boolean().optional() }))) }),
    response: z.object({ channels: anything("Type, then group, then channel.") }),
  },
  "GET /ranks": { tag: "Agency", summary: "Ranks", response: list("A rank.") },

  // Jobs (details)
  "GET /jobs": {
    tag: "Jobs",
    summary: "List details",
    query: z
      .object({
        from: agencyDate("start").optional(),
        to: agencyDate("end").optional(),
        status: csv.optional(),
        typeIds: csv.optional(),
        vendorIds: csv.optional(),
        text: z.string().optional(),
        mine: bool.optional(),
        onlyWorkable: bool.optional(),
        sort: z.string().optional(),
        direction: z.string().optional(),
        page: page.optional(),
      })
      .loose(),
    response: list("A detail."),
  },
  "POST /jobs": { tag: "Jobs", summary: "Create a detail", body: jobBody, response: record("The detail."), status: 201 },
  "GET /jobs/{id}": {
    tag: "Jobs",
    summary: "One detail",
    description: "`{id}` is the detail's id or its number, as shown in the app (`9` for Detail #9). A detail the caller may not see answers 404 either way.",
    response: record("The detail with positions, safety and attachments."),
  },
  "PATCH /jobs/{id}": { tag: "Jobs", summary: "Change a detail", description: "`?scope=series` applies it to this and later details in the series.", query: z.object({ scope: z.enum(["one", "series"]).optional() }).loose(), body: jobBody, response: record("The detail.") },
  "POST /jobs/{id}/cancel": {
    tag: "Jobs",
    summary: "Cancel a detail",
    body: z.object({ reason: text, cause: z.enum(["vendor_hold", "vendor"]).optional(), applyLateCancelPay: z.boolean().optional() }),
    response: record("The detail."),
  },
  "POST /jobs/{id}/reactivate": {
    tag: "Jobs",
    summary: "Reactivate a canceled detail",
    description:
      "Coordinators and admins, before the detail ends. It returns to its state before the cancel under the normal release rules; no sign-up is restored. The reason is required and stays with staff. No late cancel happened, so the detail's late-cancel pay is canceled.",
    body: z.object({ reason: text }),
    response: record("The detail."),
  },
  "POST /jobs/{id}/release-hold": { tag: "Jobs", summary: "Release a held detail", response: record("The detail.") },
  "POST /jobs/{id}/signup": {
    tag: "Jobs",
    summary: "Sign up for a detail",
    description: "Without `jobPositionId` the first position the caller can take is used.",
    body: z.object({ jobPositionId: text.optional(), warningVersion: z.number().int(), plannedStartAt: text.optional(), plannedEndAt: text.optional() }),
    response: record("The assignment."),
  },
  "POST /jobs/{id}/ops-plan": {
    tag: "Jobs",
    summary: "Submit the detail's ops plan",
    description: "The detail's Incident Commander only. Each submission is a new version that waits for review.",
    form: { file: "A PDF, DOCX or DOC up to 20 MB." },
    response: record("The version."),
    status: 201,
  },
  "POST /jobs/{id}/attachments": {
    tag: "Jobs",
    summary: "Attach a contract to one detail",
    form: { label: "What the contract is.", file: "A PDF, DOCX, JPG or PNG up to 20 MB.", url: "Or an https link instead of a file." },
    response: record("The attachment."),
    status: 201,
  },
  "GET /jobs/{id}/attachments/{attachmentId}/file": {
    tag: "Jobs",
    summary: "Download a detail's attachment",
    description: "Coordinators, admins and the detail's vendor. Personnel see non-contract attachments only.",
    hideForbidden: true,
    response: file("application/octet-stream", "The file."),
  },

  // Assignments and billing
  "POST /assignments/{id}/bill": {
    tag: "Billing",
    summary: "Bill a worked detail",
    body: z.object({ startAt: text, endAt: text, changeReason: text.optional(), attachW9: z.boolean().optional(), paidOnSpot: z.object({ methodId: text, reference: text.optional() }).optional() }),
    response: record("The invoice."),
  },
  "GET /billing/history": {
    tag: "Billing",
    summary: "Billing history",
    query: z.object({ from: agencyDate("start").optional(), to: agencyDate("end").optional(), vendorId: text.optional(), payeeUserId: text.optional() }).loose(),
    response: anything("Totals, a monthly chart and the list."),
  },
  "GET /billing/history/export": {
    tag: "Billing",
    summary: "Billing history as CSV",
    query: z.object({ from: agencyDate("start").optional(), to: agencyDate("end").optional(), vendorId: text.optional(), payeeUserId: text.optional() }).loose(),
    response: file("text/csv", "The list."),
  },
  "POST /billing/invoices/{id}/close": { tag: "Billing", summary: "Close an invoice as paid or written off", body: z.object({ outcome: z.enum(["paid", "written_off"]), reason: text.optional() }), response: record("The invoice.") },
  "POST /billing/invoices/{id}/mark-paid": { tag: "Billing", summary: "The deputy marks an invoice paid", body: payment, response: record("The invoice.") },
  "POST /billing/invoices/{id}/vendor-mark-paid": { tag: "Billing", summary: "The vendor marks an invoice paid", body: payment, response: record("The invoice.") },
  "GET /billing/invoices/{id}/timeline": { tag: "Billing", summary: "An invoice's timeline", response: anything("The invoice and its events.") },
  "GET /invoices/review": { tag: "Billing", summary: "Invoices waiting for review", response: list("An invoice.") },
  "POST /invoices/{id}/approve": {
    tag: "Billing",
    summary: "Approve an invoice",
    description: "`send: false` approves it without sending (status approved_unsent: no email, no batch, the vendor does not see it). Left out, the vendor's emailApprovedInvoices setting decides.",
    body: z.object({ send: z.boolean().optional(), attachW9: z.boolean().optional() }).loose().optional(),
    response: record("The invoice."),
  },
  "POST /invoices/{id}/resend": {
    tag: "Billing",
    summary: "Resend an invoice already sent",
    description: "Coordinators and admins. Goes to the vendor's billing emails, plus `alsoTo` when given (not saved). A paid invoice resends its paid version. The revision and response times do not change.",
    body: z.object({ alsoTo: z.string().optional() }).loose().optional(),
    response: z.object({ to: z.array(z.string()) }),
  },
  "POST /invoices/{id}/send": {
    tag: "Billing",
    summary: "Send an invoice approved without sending",
    description: "Follows the normal send path: emailed now, or queued for the vendor's next batch.",
    response: record("The invoice."),
  },
  "POST /invoices/{id}/edit": {
    tag: "Billing",
    summary: "Edit an invoice under review",
    body: z.object({ startAt: text.optional(), endAt: text.optional(), rateCents: z.number().optional(), minimumBillableMinutes: z.number().optional(), reason: text.optional() }),
    response: record("The invoice."),
  },
  "POST /invoices/{id}/send-back": { tag: "Billing", summary: "Send an invoice back to the deputy", body: z.object({ comment: text.optional() }).loose().optional(), response: record("The invoice.") },
  "GET /invoices/{id}/pdf": { tag: "Billing", summary: "An invoice PDF", hideForbidden: true, response: file("application/pdf", "The invoice.") },

  // Calendar and planning
  "GET /calendar.ics": { tag: "Planning", summary: "A personal calendar feed", description: "The token in the link is the only credential.", public: true, query: z.object({ token: text.optional() }).loose(), response: file("text/calendar", "The feed.") },
  "GET /me/calendar-busy": { tag: "Planning", summary: "Busy times from the linked calendar", response: list("A busy time.") },
  "GET /me/calendar-feed": { tag: "Planning", summary: "Whether a calendar link is set", response: anything("Status; the link itself is never returned.") },
  "PUT /me/calendar-feed": { tag: "Planning", summary: "Set or remove the calendar link", body: z.object({ url: z.string().nullable() }), description: "A new link is imported at once, with the same once-per-15-minutes limit as Sync now; `waitMessage` says when it can sync again.", response: z.object({ ok: z.literal(true), connected: z.boolean(), lastFetchedAt: text.nullable(), lastError: text.nullable(), waitMessage: text.nullable() }) },
  "POST /me/calendar-feed/sync": { tag: "Planning", summary: "Sync the linked calendar now", response: anything("The sync result.") },
  "GET /me/earnings-goal": { tag: "Planning", summary: "The earnings goal and progress", response: anything("Goal progress.") },
  "PUT /me/earnings-goal": { tag: "Planning", summary: "Set the earnings goal", body: z.object({ monthlyCents: z.number().int().nullable() }), response: anything("Goal progress.") },
  "GET /me/hidden-vendors": { tag: "Planning", summary: "Hidden vendors", response: list("A hidden vendor.") },
  "POST /me/hidden-vendors": { tag: "Planning", summary: "Hide a vendor", body: z.object({ vendorId: text }), response: ok, status: 201 },
  "DELETE /me/hidden-vendors/{vendorId}": { tag: "Planning", summary: "Show a hidden vendor again", response: ok },
  "GET /me/recommendations": { tag: "Planning", summary: "Recommended details", response: anything("Recommendations.") },
  "GET /me/schedule-exceptions": { tag: "Planning", summary: "Work schedule exceptions", response: list("An exception.") },
  "POST /me/schedule-exceptions": {
    tag: "Planning",
    summary: "Add a schedule exception",
    body: z.object({ date: text.meta({ description: "Agency date YYYY-MM-DD." }), kind: z.enum(["off", "extra"]), shiftStart: text.optional(), shiftEnd: text.optional() }),
    response: record("The exception."),
    status: 201,
  },
  "DELETE /me/schedule-exceptions/{id}": { tag: "Planning", summary: "Remove a schedule exception", response: ok },
  "GET /me/work-schedule": { tag: "Planning", summary: "The work schedule", response: anything("The schedule, or null.") },
  "PUT /me/work-schedule": {
    tag: "Planning",
    summary: "Set the work schedule",
    body: z
      .object({ kind: z.enum(["weekly", "rotation"]), weekdays: z.array(z.number().int()).optional(), cycle: text.optional(), anchorDate: text.optional(), shiftStart: text, shiftEnd: text, bufferMinutes: z.number().int(), active: z.boolean().optional() })
      .nullable(),
    response: anything("The schedule."),
  },

  // Profile
  "PUT /me/maps-app": { tag: "Profile", summary: "Choose the maps app", body: z.object({ app: z.enum(["google", "apple", "osm", "ask"]) }), response: z.object({ app: text }) },
  "PUT /me/theme": { tag: "Profile", summary: "Choose day or night", body: z.object({ theme: z.enum(["day", "night", "system"]) }), response: z.object({ theme: text }) },
  "GET /me/w9": { tag: "Profile", summary: "Download your W-9", w9: true, hideForbidden: true, response: file("application/pdf", "The W-9.") },
  "POST /me/w9": { tag: "Profile", summary: "Upload your W-9", w9: true, form: { file: "A PDF up to 20 MB." }, response: z.object({ uploadedAt: text }) },

  // Deputy notes
  "GET /deputy-notes": { tag: "Deputy notes", summary: "Approved notes for a detail", query: z.object({ jobId: text }).loose(), response: list("A note.") },
  "POST /deputy-notes": { tag: "Deputy notes", summary: "Submit a note", body: z.object({ jobId: text, body: text, scope: z.enum(["vendor", "location"]) }), response: record("The note."), status: 201 },
  "PATCH /deputy-notes/{id}": { tag: "Deputy notes", summary: "Edit a note", body: z.object({ body: text }), response: record("The note.") },
  "POST /deputy-notes/{id}/review": { tag: "Deputy notes", summary: "Approve or deny a note", body: z.object({ decision: z.enum(["approve", "deny"]), editedBody: text.optional(), comment: text.optional() }), response: record("The note.") },
  "POST /deputy-notes/{id}/retire": { tag: "Deputy notes", summary: "Retire a note", response: record("The note.") },

  // Geocoding
  "GET /geocode": { tag: "Places", summary: "Look an address up on OpenStreetMap", query: z.object({ q: z.string().optional() }).loose(), response: z.object({ status: z.enum(["match", "none", "unavailable"]), match: z.unknown() }) },

  // Messages
  "GET /messages": { tag: "Messages", summary: "Inbox", query: z.object({ text: z.string().optional(), unreadOnly: bool.optional(), page: page.optional() }).loose(), response: anything("A page of the inbox.") },
  "POST /messages": { tag: "Messages", summary: "Send a message", body: z.object({ audiences: z.array(audience), subject: text, body: text, jobId: text.optional(), replyToMessageId: text.optional() }), response: record("The message."), status: 201 },
  "GET /messages/{id}": { tag: "Messages", summary: "One message", response: record("The message.") },
  "POST /messages/coordinators": { tag: "Messages", summary: "Message the coordinators about a detail", body: z.object({ jobId: text, body: text }), response: record("The message."), status: 201 },
  "POST /messages/hide": { tag: "Messages", summary: "Remove messages from the inbox", body: z.object({ ids }), response: ok },
  "POST /messages/read": { tag: "Messages", summary: "Mark messages read or unread", body: z.object({ ids, read: z.boolean().optional() }), response: ok },
  "GET /messages/sent": { tag: "Messages", summary: "Sent messages", query: z.object({ page: page.optional() }).loose(), response: anything("A page of sent messages.") },

  // Ops plans
  "GET /ops-plans/versions/{id}/file": { tag: "Ops plans", summary: "Download an ops plan version", hideForbidden: true, response: file("application/octet-stream", "The ops plan.") },

  // Reports
  "GET /reports/earnings": { tag: "Reports", summary: "Earnings dashboard", query: z.object({ userId: text.optional() }).loose(), response: anything("Earnings.") },
  "POST /reports/run": { tag: "Reports", summary: "Run a report", readOnly: true, body: reportSpec, response: anything("The report rows and totals.") },
  "POST /reports/export": { tag: "Reports", summary: "Export a report", readOnly: true, body: reportSpec.extend({ format: z.enum(["csv", "pdf"]) }), response: file("text/csv", "CSV or PDF.") },
  "GET /reports/saved": { tag: "Reports", summary: "Saved reports", response: list("A saved report.") },
  "POST /reports/saved": { tag: "Reports", summary: "Save a report", body: reportSpec.extend({ name: text }), response: record("The saved report."), status: 201 },
  "DELETE /reports/saved/{id}": { tag: "Reports", summary: "Delete a saved report", response: z.object({ id: text }) },
  "POST /reports/saved/{id}/run": { tag: "Reports", summary: "Run a saved report", readOnly: true, body: period.optional(), response: anything("The report rows and totals.") },
  "POST /reports/saved/{id}/export": { tag: "Reports", summary: "Export a saved report", readOnly: true, body: period.extend({ format: z.enum(["csv", "pdf"]) }), response: file("text/csv", "CSV or PDF.") },
  "GET /reports/tax/{year}": { tag: "Reports", summary: "Payment summary for a tax year", query: z.object({ userId: text.optional() }).loose(), response: anything("The summary.") },
  "GET /reports/tax/{year}/export": { tag: "Reports", summary: "Export a tax year summary", query: z.object({ userId: text.optional(), format: z.enum(["csv", "pdf"]) }).loose(), response: file("text/csv", "CSV or PDF.") },

  // Users
  "GET /users": { tag: "Users", summary: "Users", response: list("A user.") },
  "POST /users": {
    tag: "Users",
    summary: "Invite a user",
    body: z.object({ email: text, name: text, phone: z.string().nullable().default(null), role: z.enum(["admin", "coordinator", "personnel", "vendor"]), rankId: z.string().nullable().default(null), badgeNumber: z.string().nullable().default(null), qualificationIds: ids.optional() }),
    response: record("The user."),
    status: 201,
  },
  "PATCH /users/{id}": {
    tag: "Users",
    summary: "Change a user",
    body: z.object({ name: text, phone: z.string().nullable(), role: z.enum(["admin", "coordinator", "personnel", "vendor"]), rankId: z.string().nullable(), badgeNumber: z.string().nullable(), mailingAddress: z.string().nullable() }).partial(),
    response: record("The user."),
  },
  "GET /users/{id}/deactivate/preview": {
    tag: "Users",
    summary: "Checklist before someone leaves",
    description: "Changes nothing. Sign-ups on details after the last day (removed on deactivation), worked details not yet billed, and invoices vendors still owe the person.",
    query: z.object({ lastDay: lastDay }),
    response: departureLists("upcoming"),
  },
  "POST /users/{id}/deactivate": {
    tag: "Users",
    summary: "Deactivate someone who leaves",
    description: "Turns the account off with a reason and last day. Sign-ups on details after the last day are removed (backups are offered the spots or they reopen); unbilled work and unpaid invoices stay and are returned.",
    body: z.object({ reason: text, lastDay }),
    response: z.object({ user: record("The user.") }).extend(departureLists("removed").shape),
  },
  "POST /users/{id}/reactivate": {
    tag: "Users",
    summary: "Reactivate a user",
    description: "Turns a deactivated account back on. Old sign-ups are not restored; calendar feeds and API keys stay revoked.",
    body: z.object({ reason: text }),
    response: record("The user."),
  },
  "POST /users/{id}/suspension": {
    tag: "Users",
    summary: "Suspend a user",
    body: z.object({ reason: text, until: agencyDate("start").nullable().optional().transform((v) => v ?? null).meta({ description: "A date (from agency midnight) or timestamp; null or left out for no end." }), removeFutureAssignments: z.boolean().optional() }),
    response: record("The user."),
  },
  "GET /users/{id}/managed-vendors": { tag: "Users", summary: "Vendors a deputy manages", description: "Coordinators and admins.", response: z.object({ vendorIds: z.array(text) }) },
  "PUT /users/{id}/managed-vendors": {
    tag: "Users",
    summary: "Set the vendors a deputy manages",
    description: "Coordinators and admins. For these vendors only, the deputy creates, edits, staffs, holds, releases, cancels and reactivates details, decides the vendor's requests and keeps its locations and site contacts. Only a deputy (personnel) can manage vendors; an empty list clears it. Audited.",
    body: z.object({ vendorIds: z.array(text) }),
    response: z.object({ vendorIds: z.array(text) }),
  },
  "DELETE /users/{id}/suspension": { tag: "Users", summary: "Lift a suspension", response: record("The user.") },
  "GET /users/{id}/w9": { tag: "Users", summary: "Download a person's W-9", description: "The owner, coordinators and admins; every read is audited. API keys need the w9 scope.", w9: true, hideForbidden: true, response: file("application/pdf", "The W-9.") },
  "POST /users/{id}/w9": {
    tag: "Users",
    summary: "Upload a W-9 for a person",
    description: "Coordinators and admins. Stored encrypted; it becomes the person's latest W-9, pending review. API keys need the w9 scope.",
    w9: true,
    form: { file: "A PDF up to 20 MB." },
    response: z.object({ id: text, status: text, uploadedAt: text }),
  },
  "GET /w9-requests": { tag: "Users", summary: "W-9 renewal requests", description: "Coordinators and admins. Newest first, with counts of people done, pending review, rejected and missing.", response: list("A request.") },
  "POST /w9-requests": {
    tag: "Users",
    summary: "Ask for a new W-9",
    description: "Coordinators and admins. After the due date (an agency date), each person asked without a W-9 uploaded since and approved is sign-up locked. Each is notified, with reminders a week and a day before.",
    body: z.object({
      audience: z.discriminatedUnion("kind", [
        z.object({ kind: z.literal("everyone") }),
        z.object({ kind: z.literal("users"), userIds: z.array(text) }),
        z.object({ kind: z.literal("rank"), rankId: text }),
        z.object({ kind: z.literal("flag"), qualificationId: text }),
      ]),
      dueOn: text.meta({ description: "YYYY-MM-DD, after today." }),
      note: optText,
    }),
    response: record("The request."),
    status: 201,
  },
  "POST /users/{id}/w9/review": {
    tag: "Users",
    summary: "Approve or reject a person's W-9",
    description: "Coordinators and admins, for the person's latest W-9 while it is pending. Approve with the signature date (YYYY-MM-DD) and the IRS form revision; reject with a reason. The person is notified; audited.",
    body: z.discriminatedUnion("decision", [
      z.object({ decision: z.literal("approve"), signedOn: text, formRevision: text }),
      z.object({ decision: z.literal("reject"), reason: text }),
    ]),
    response: z.object({ id: text, status: text, signedOn: optText, formRevision: optText, rejectReason: optText }),
  },

  // Vendors
  "GET /vendors": { tag: "Vendors", summary: "Vendors", query: z.object({ active: bool.optional(), typeId: text.optional() }).loose(), response: list("A vendor.") },
  "POST /vendors": { tag: "Vendors", summary: "Add a vendor", body: vendorCreate, response: record("The vendor."), status: 201 },
  "PATCH /vendors/{id}": { tag: "Vendors", summary: "Change a vendor", description: "Vendor fields, or `{ active }` alone to deactivate or reactivate.", body: vendorBody.extend({ active: z.boolean().optional() }), response: record("The vendor.") },
  "GET /vendors/{id}/documents": { tag: "Vendors", summary: "A vendor's contracts and documents", response: list("A document.") },
  "POST /vendors/{id}/documents": {
    tag: "Vendors",
    summary: "Add a contract or document",
    form: { kind: "contract or other", label: "What it is.", signedOn: "Agency date YYYY-MM-DD.", expiresOn: "Agency date YYYY-MM-DD.", file: "A PDF, DOCX, JPG or PNG up to 20 MB.", url: "Or an https link instead of a file." },
    response: record("The document."),
    status: 201,
  },
  "GET /vendors/{id}/documents/{documentId}/file": {
    tag: "Vendors",
    summary: "Download a vendor document",
    description: "That vendor's own users, coordinators and admins.",
    hideForbidden: true,
    response: file("application/octet-stream", "The file."),
  },
  "GET /vendors/{id}/locations": { tag: "Vendors", summary: "A vendor's locations", query: z.object({ includeInactive: bool.optional() }).loose(), response: list("A location.") },
  "POST /vendors/{id}/locations": { tag: "Vendors", summary: "Add a location", body: locationCreate, response: record("The location."), status: 201 },
  "PATCH /vendors/{id}/locations/{locationId}": { tag: "Vendors", summary: "Change a location", body: locationBody, response: record("The location.") },
  "PUT /vendors/{id}/locations/{locationId}/active": { tag: "Vendors", summary: "Deactivate or reactivate a location", body: z.object({ active: z.boolean() }), response: record("The location.") },
  "PUT /vendors/{id}/locations/{locationId}/pin": { tag: "Vendors", summary: "Place a location's map pin", body: z.object({ lat: z.number(), lng: z.number() }), response: record("The location.") },
  "POST /vendors/{id}/logins": { tag: "Vendors", summary: "Add a vendor login", body: z.object({ email: text, name: text }), response: record("The user."), status: 201 },
  "POST /vendors/{id}/payment-hold": { tag: "Vendors", summary: "Place a payment hold", body: z.object({ reason: text }), response: record("The vendor.") },
  "DELETE /vendors/{id}/payment-hold": { tag: "Vendors", summary: "Resolve a payment hold", body: z.object({ outcome: z.enum(["fix_coming", "handled"]), note: text.optional() }), response: record("The vendor.") },
  "POST /vendor-requests": {
    tag: "Vendors",
    summary: "A vendor requests a detail",
    form: { request: "The request as JSON.", contractFile: "An optional contract file up to 20 MB." },
    response: z.object({ id: text, count: z.number().int() }),
    status: 201,
  },
});

/** Every route definition, for the OpenAPI document. */
export function allRoutes(): RouteDef[] {
  return Object.values(routes) as RouteDef[];
}
