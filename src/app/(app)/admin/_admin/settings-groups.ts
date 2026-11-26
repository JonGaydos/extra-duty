import type { AgencySettings } from "@/domain/settings/settings";
import { scalarText } from "@/lib/text";

/**
 * The settings screens, as data. Each group is one page with one Save; each field names its place in the
 * agency settings by a dotted key ("responseDays.vendor"). The server converts and validates the whole group
 * with the agency settings schema, so a field's limits live in one place.
 */

type FieldKind = "int" | "float" | "hours" | "dollars" | "dollarsOptional" | "phone" | "text" | "textarea" | "email" | "time" | "select" | "weekday" | "date" | "switch" | "reviewers" | "positionType";

export type Field = {
  key: string;
  label: string;
  kind: FieldKind;
  hint?: string;
  options?: Array<[string, string]>;
  /** Shown when a typed value does not match the expected pattern. */
  formatHint?: string;
  /** dollars: a stored zero shows blank, and blank saves zero (no amount set). */
  blankIsZero?: boolean;
};

export type Group = { slug: string; title: string; intro: string; save: string; saved: string; fields: Field[] };

export const WEEKDAYS: Array<[string, string]> = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"].map((d, i) => [String(i), d]);

export const GROUPS = {
  release: {
    slug: "release",
    title: "Release",
    intro: "When new details open for sign-up each month.",
    save: "Save release settings",
    saved: "Release settings saved.",
    fields: [
      { key: "releaseDayOfMonth", label: "Release day of month", kind: "int", hint: "Details open on this day of the month before they happen. A day past a month's end uses its last day." },
      { key: "releaseTime", label: "Release time", kind: "time", hint: "Agency time (Central).", formatHint: "Enter a time such as 4:00 PM." },
    ],
  },
  signup: {
    slug: "signup",
    title: "Sign-up",
    intro: "Hour caps, backups and what people see before they sign up.",
    save: "Save sign-up settings",
    saved: "Sign-up settings saved.",
    fields: [
      { key: "weekStartsOn", label: "Week starts on", kind: "weekday", hint: "Weekly hour caps reset at the start of this day." },
      { key: "rollingCapWindowHours", label: "Rolling cap window (hours)", kind: "int", hint: "The rolling cap counts hours worked in any window this long." },
      {
        key: "capHoursMode",
        label: "Hours that count toward caps",
        kind: "select",
        options: [
          ["details_only", "Detail hours only"],
          ["details_plus_schedule", "Detail hours plus regular shifts"],
        ],
      },
      { key: "shortShiftWindowHours", label: "Shorter sign-ups need approval until (hours before)", kind: "int", hint: "Inside this window, someone can sign up for part of a detail without approval." },
      {
        key: "backupOfferMode",
        label: "When a spot opens",
        kind: "select",
        options: [
          ["sequential", "Offer it to one backup at a time, in order"],
          ["all_backups", "Offer it to all backups at once"],
          ["everyone", "Open it to everyone eligible"],
        ],
      },
      { key: "backupWindowMinutes", label: "Time a backup has to accept (minutes)", kind: "int" },
      { key: "backupFirstComeHours", label: "First come, first served within (hours)", kind: "int", hint: "Inside this many hours of the start, an open spot goes to the first eligible person." },
      { key: "defaultPositionTypeId", label: "Default position on new details", kind: "positionType" },
      { key: "signupWarningText", label: "Sign-up warning", kind: "textarea", hint: "Shown before someone signs up. Changing it asks everyone to read it again." },
      { key: "personnelCanMessageAll", label: "Deputies can message all personnel", kind: "switch" },
    ],
  },
  billing: {
    slug: "billing",
    title: "Billing and invoices",
    intro: "How hours are billed, how invoices are numbered and reviewed, and late cancellations.",
    save: "Save billing settings",
    saved: "Billing settings saved.",
    fields: [
      { key: "minimumBillableMinutes", label: "Minimum billable time (hours)", kind: "hours", hint: "Shorter details are billed at this length.", formatHint: "Enter hours, such as 4 or 4.5." },
      { key: "hourRoundingMinutes", label: "Round worked time up to (minutes)", kind: "int" },
      { key: "agencyDefaultRateCents", label: "Agency default rate per hour", kind: "dollars", blankIsZero: true, hint: "Used when a vendor has no rate of its own. Blank for no agency default.", formatHint: "Enter dollars, such as 70 or 72.50, or leave it blank." },
      { key: "rateMinCents", label: "Lowest rate allowed per hour", kind: "dollarsOptional", hint: "Blank for no lower limit. Applies to every detail and default rate.", formatHint: "Enter dollars, such as 50, or leave it blank." },
      { key: "rateMaxCents", label: "Highest rate allowed per hour", kind: "dollarsOptional", hint: "Blank for no upper limit. Details already outside keep their rate.", formatHint: "Enter dollars, such as 95, or leave it blank." },
      {
        key: "invoiceReviewMode",
        label: "Invoice review",
        kind: "select",
        options: [
          ["immediate", "Send every invoice right away"],
          ["changed_hours_only", "Review invoices whose hours changed"],
          ["all", "Review every invoice"],
        ],
      },
      {
        key: "invoiceSendSchedule",
        label: "Send approved invoices",
        kind: "select",
        options: [
          ["immediate", "Right away, one email per invoice"],
          ["weekly", "Weekly, one email per vendor"],
          ["every_2_weeks", "Every two weeks, one email per vendor"],
          ["monthly", "Monthly, one email per vendor"],
        ],
        hint: "A vendor can have its own schedule. Batches show up under Send invoices on their send day.",
      },
      { key: "invoiceSendDayOfWeek", label: "Weekly and every-two-weeks send day", kind: "weekday" },
      { key: "invoiceSendStartDate", label: "First every-two-weeks send", kind: "date", hint: "Sends repeat every two weeks from the send day on or after this date.", formatHint: "Enter a date." },
      { key: "invoiceSendDayOfMonth", label: "Monthly send day", kind: "int", hint: "A day past a month's end uses its last day." },
      { key: "waitForAllDeputies", label: "Hold a detail's invoices until every deputy has billed", kind: "switch", hint: "Applies to batched sends. A detail can turn it off, and a coordinator can still send early with a reason." },
      { key: "invoiceNumberPrefix", label: "Invoice number prefix", kind: "text" },
      { key: "billingReplyToEmail", label: "Billing reply-to address", kind: "email", hint: "Vendors' replies to invoice emails go here." },
      { key: "lateVendorCancelHours", label: "Late cancellation window (hours)", kind: "int", hint: "A vendor that cancels inside this window still pays." },
      {
        key: "lateCancelPayBasis",
        label: "Late cancellation pays",
        kind: "select",
        options: [
          ["minimum", "The minimum billable time"],
          ["scheduled", "The scheduled hours"],
        ],
      },
      { key: "responseDays.vendor", label: "Vendor response time on payment issues (days)", kind: "int" },
      { key: "responseDays.deputy", label: "Deputy response time on payment issues (days)", kind: "int" },
      { key: "responseDays.coordinator", label: "Coordinator response time on payment issues (days)", kind: "int" },
    ],
  },
  reminders: {
    slug: "reminders",
    title: "Reminders and locks",
    intro: "Reminders about unbilled and unpaid work, and the locks that stop sign-up until it is handled.",
    save: "Save reminder settings",
    saved: "Reminder settings saved.",
    fields: [
      {
        key: "unbilledReminderFrequency",
        label: "Unbilled details reminder",
        kind: "select",
        options: [
          ["daily", "Every day"],
          ["every_other_day", "Every other day"],
          ["weekly", "Every week"],
        ],
      },
      { key: "unbilledGraceHours", label: "Time to bill after a detail ends (hours)", kind: "int", hint: "After this, reminders start and the billing lock can apply." },
      { key: "billingLockEnabled", label: "Lock sign-up while a deputy has unbilled details", kind: "switch" },
      {
        key: "paymentAckLockMode",
        label: "Lock sign-up until a deputy confirms payment",
        kind: "select",
        options: [
          ["off", "Never"],
          ["vendor_reported", "When the vendor reports paying"],
          ["all_invoices", "For every invoice"],
        ],
      },
      { key: "vendorReminderEnabled", label: "Remind vendors about unpaid invoices", kind: "switch" },
      { key: "inactivityLockDays", label: "Lock accounts unused for (days)", kind: "int" },
      { key: "trainingNightlyReset", label: "Reset training data to the demo data every night at 2:00 AM", kind: "switch" },
    ],
  },
  vendors: {
    slug: "vendors",
    title: "Vendor limits",
    intro: "What vendors may request, change and see.",
    save: "Save vendor limits",
    saved: "Vendor limits saved.",
    fields: [
      { key: "vendorMinNoticeHours", label: "Minimum notice for a request (hours)", kind: "int" },
      { key: "vendorEditLockHours", label: "No vendor changes within (hours of the start)", kind: "int" },
      {
        key: "vendorEditsAfterSignup",
        label: "Vendor changes after someone signs up",
        kind: "select",
        options: [
          ["none", "None"],
          ["add_positions", "Adding positions only"],
        ],
      },
      { key: "vendorCancelUntilHours", label: "Vendors can cancel until (hours before)", kind: "int" },
      { key: "vendorCanSetRate", label: "Vendors can set the rate", kind: "switch" },
      { key: "vendorSeesAssignedNames", label: "Vendors see who is assigned", kind: "switch" },
    ],
  },
  "ops-plans": {
    slug: "ops-plans",
    title: "Ops plan review",
    intro: "Who reviews operations plans and when plans are due.",
    save: "Save ops plan settings",
    saved: "Ops plan settings saved.",
    fields: [
      { key: "opsPlanReviewerUserIds", label: "Reviewers", kind: "reviewers", hint: "Nobody reviews their own plan or a plan for a detail they command." },
      { key: "opsPlanDefaultDueHours", label: "Plans are due (hours before the detail)", kind: "int" },
    ],
  },
  map: {
    slug: "map",
    title: "Map",
    intro: "Where maps open and which map tiles they use.",
    save: "Save map settings",
    saved: "Map settings saved.",
    fields: [
      { key: "mapDefaultCenter.lat", label: "Default center latitude", kind: "float" },
      { key: "mapDefaultCenter.lng", label: "Default center longitude", kind: "float" },
      { key: "mapDefaultCenter.zoom", label: "Default zoom (1 to 19)", kind: "int" },
      { key: "mapTileUrl", label: "Tile address", kind: "text", hint: "A URL with {z}, {x} and {y} in it." },
      { key: "mapAttribution", label: "Attribution", kind: "text", hint: "Credit the tile provider as its terms require." },
    ],
  },
  agency: {
    slug: "agency",
    title: "Agency profile",
    intro: "Shown on invoices and sign-in.",
    save: "Save agency profile",
    saved: "Agency profile saved.",
    fields: [
      { key: "agency.name", label: "Agency name", kind: "text" },
      { key: "agency.sheriffName", label: "Sheriff's name", kind: "text" },
      { key: "agency.address", label: "Address", kind: "textarea" },
      { key: "agency.phone", label: "Phone", kind: "phone" },
      { key: "agency.email", label: "Email", kind: "email" },
      { key: "agency.website", label: "Website", kind: "text" },
    ],
  },
  "access-review": {
    slug: "access-review",
    title: "Review schedule",
    intro: "",
    save: "Save schedule",
    saved: "Schedule saved.",
    fields: [
      { key: "accessReviewMonthDay", label: "Review date (MM-DD)", kind: "text", formatHint: "Enter the month and day as MM-DD, such as 01-15." },
      { key: "accessReviewEveryMonths", label: "Repeat every (months)", kind: "int" },
    ],
  },
  security: {
    slug: "security",
    title: "Security",
    intro: "Sign-in codes, trusted devices and passwords.",
    save: "Save security settings",
    saved: "Security settings saved.",
    fields: [
      { key: "security.emailCodeMinutes", label: "Sign-in code lifetime (minutes)", kind: "int" },
      { key: "security.emailCodeAttempts", label: "Wrong codes allowed before a new one is needed", kind: "int" },
      { key: "security.trustedDeviceDays", label: "Trusted devices stay signed in (days)", kind: "int" },
      { key: "security.passwordMinLength", label: "Minimum password length", kind: "int" },
    ],
  },
} as const satisfies Record<string, Group>;

export type GroupSlug = keyof typeof GROUPS;
/** Groups on the shared settings page route; the rest have their own pages. */
export const PAGE_GROUPS = ["release", "signup", "billing", "reminders", "vendors", "ops-plans", "map"] as const satisfies readonly GroupSlug[];

type FieldValue = string | boolean | string[];
export type GroupValues = Record<string, FieldValue>;

export function getPath(obj: unknown, key: string): unknown {
  return key.split(".").reduce<unknown>((o, k) => (o && typeof o === "object" ? (o as Record<string, unknown>)[k] : undefined), obj);
}

/** Cents as dollars for a form: "70" for whole dollars, "72.50" otherwise, blank for no amount. */
function dollarsText(v: unknown): string {
  if (typeof v !== "number") return "";
  return v % 100 === 0 ? String(v / 100) : (v / 100).toFixed(2);
}

/** A typed field's starting text, from its saved value. */
function fieldText(f: Field, v: unknown): string {
  if (f.kind === "dollars" && f.blankIsZero && v === 0) return "";
  if (f.kind === "dollars" || f.kind === "dollarsOptional") return dollarsText(v);
  if (f.kind === "hours") return typeof v === "number" ? String(Math.round((v / 60) * 100) / 100) : "";
  return scalarText(v);
}

/** The form's starting values, from the saved settings. */
export function groupValues(group: Group, s: AgencySettings): GroupValues {
  const out: GroupValues = {};
  for (const f of group.fields) {
    const v = getPath(s, f.key);
    if (f.kind === "switch") out[f.key] = v === true;
    else if (f.kind === "reviewers") out[f.key] = Array.isArray(v) ? (v as string[]) : [];
    else out[f.key] = fieldText(f, v);
  }
  return out;
}
