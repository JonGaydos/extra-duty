import type { NotificationType } from "./types";

/**
 * Every notification and email the app sends, as the agency's Notifications page lists them. Each entry names the
 * recipient groups that can receive it; the agency turns Email and Push on or off per type and group. A source scan
 * test keeps this complete: every email the app sends outside the notify path has an entry here.
 */

export const RECIPIENT_GROUPS = ["vendor", "personnel", "staff"] as const;
export type RecipientGroup = (typeof RECIPIENT_GROUPS)[number];
export const GROUP_LABEL: Record<RecipientGroup, string> = { vendor: "Vendors", personnel: "Deputies and personnel", staff: "Coordinators and admins" };

const CHANNELS = ["email", "push"] as const;
export type Channel = (typeof CHANNELS)[number];

export const CATEGORIES = ["Details", "Sign-ups", "Billing and invoices", "Payments", "Vendor requests", "Ops plans", "Messages", "Account"] as const;
type Category = (typeof CATEGORIES)[number];

/** Emails sent outside the notify path: no inbox row, no push. */
type EmailOnlyKey =
  | "auth.sign_in_code"
  | "auth.invite"
  | "auth.password_reset"
  | "settings.test_email"
  | "invoice.delivery"
  | "invoice.vendor_payment_reminder";
export type CatalogKey = NotificationType | EmailOnlyKey;

export type CatalogEntry = {
  category: Category;
  label: string;
  /** When it goes out, in one line. */
  description: string;
  groups: readonly RecipientGroup[];
  /** Always on: the reason, shown beside the lock. */
  locked?: string;
  /**
   * In-app inbox only, locked: never emailed or pushed, whatever the agency switches or personal choices say. The
   * reason is shown beside it.
   */
  inAppOnly?: string;
  /** Sent only by email (no inbox row and no push), for example to a vendor's billing addresses. */
  emailOnly?: boolean;
  /** Groups reached only by email for this type (vendor billing addresses). Vendors never get push. */
  emailOnlyGroups?: readonly RecipientGroup[];
  /** A note shown under the description. */
  note?: string;
  /** In the type list but not sent at present; not shown on the page. */
  unused?: true;
};

const P = ["personnel"] as const;
const S = ["staff"] as const;
const PS = ["personnel", "staff"] as const;
const ALL = ["vendor", "personnel", "staff"] as const;

export const CATALOG: Record<CatalogKey, CatalogEntry> = {
  // Details
  "job.changed": { category: "Details", label: "Detail changed", description: "A detail someone is on or backing up changes, including its time or rate.", groups: P },
  "job.safety_changed": { category: "Details", label: "Officer safety changed", description: "Officer safety information on a detail someone is on changes.", groups: P },
  "job.canceled": {
    category: "Details",
    label: "Detail canceled",
    description: "A detail is canceled. Goes to the people on it and its backups, and to the vendor when staff cancel it.",
    groups: ["vendor", "personnel"],
  },
  "job.reactivated": { category: "Details", label: "Detail reactivated", description: "A canceled detail is back on. Goes to the people who were on it and to the vendor.", groups: ["vendor", "personnel"] },
  "job.locked": { category: "Details", label: "Detail locked", description: "A vendor's payment hold locks a detail someone is on.", groups: P },
  "job.unlocked": { category: "Details", label: "Detail unlocked", description: "A vendor's payment hold is lifted on a detail someone is on.", groups: P },
  "job.late_cancel_waived": { category: "Details", label: "Late cancellation pay waived", description: "A coordinator waives the late cancellation pay on a canceled detail.", groups: P },
  "deputyNote.submitted": { category: "Details", label: "Deputy note submitted", description: "A deputy submits a note about a vendor or location for review.", groups: S },
  "deputyNote.approved": { category: "Details", label: "Deputy note approved", description: "A coordinator approves the note a person submitted.", groups: P },
  "deputyNote.denied": { category: "Details", label: "Deputy note denied", description: "A coordinator denies the note a person submitted.", groups: P },

  // Sign-ups
  "spot.offered": { category: "Sign-ups", label: "Backup spot offered", description: "A spot opens and is offered to backups, in turn or all at once.", groups: P },
  "spot.opened_first_come": { category: "Sign-ups", label: "Spot open to anyone", description: "A spot opens first come, first served close to the start.", groups: P },
  "spot.offer_ended": { category: "Sign-ups", label: "Spot offer ended", description: "A coordinator fills a spot that was being offered to backups.", groups: P },
  "job.watch_opened": { category: "Sign-ups", label: "Watched detail has a spot", description: "A spot opens on a detail the person is watching and they can take it.", groups: P },
  "job.watch_released": { category: "Sign-ups", label: "Watched detail released", description: "A detail the person is watching opens for sign-up.", groups: P },
  "assignment.assigned": { category: "Sign-ups", label: "Assigned by a coordinator", description: "A coordinator assigns the person to a detail.", groups: P, note: "Ignores personal choices and quiet hours." },
  "assignment.removed": { category: "Sign-ups", label: "Removed by a coordinator", description: "A coordinator removes the person from a detail.", groups: P, note: "Ignores personal choices and quiet hours." },
  "signup.short_confirmed": { category: "Sign-ups", label: "Shorter shift confirmed", description: "A request to work part of a detail is confirmed.", groups: P },
  "signup.short_declined": { category: "Sign-ups", label: "Shorter shift declined", description: "A request to work part of a detail is declined, or the detail is canceled.", groups: P },

  // Billing and invoices
  "billing.ready": { category: "Billing and invoices", label: "Detail ready to bill", description: "A worked detail has ended and can be billed.", groups: P },
  "billing.unbilled_reminder": { category: "Billing and invoices", label: "Unbilled details reminder", description: "Details are still unbilled after the grace period, on the reminder schedule.", groups: P },
  "billing.lock_overridden": { category: "Billing and invoices", label: "Billing lock lifted", description: "A coordinator lifts a person's billing lock for a time.", groups: P },
  "invoice.edited": { category: "Billing and invoices", label: "Invoice edited", description: "A coordinator edits the person's invoice.", groups: P },
  "invoice.returned": { category: "Billing and invoices", label: "Invoice sent back", description: "A coordinator sends the person's invoice back to fix and bill again.", groups: P },
  "invoice.review_waiting": { category: "Billing and invoices", label: "Invoice waiting for review", description: "A billed invoice is held for a coordinator's review.", groups: S },
  "invoice.batch_due": { category: "Billing and invoices", label: "Invoice batch due", description: "Batched invoices for a vendor are due to send today.", groups: S },
  "invoice.email_failed": { category: "Billing and invoices", label: "Invoice email failed", description: "An invoice could not be emailed to the vendor.", groups: PS },
  "settings.email_incomplete": { category: "Billing and invoices", label: "Email settings incomplete", description: "Invoices cannot be sent because the email settings are not finished.", groups: S },
  "invoice.delivery": {
    category: "Billing and invoices",
    label: "Invoice to the vendor",
    description: "The invoice email with its PDF, sent when an invoice is approved or its batch goes out.",
    groups: ["vendor"],
    emailOnly: true,
    locked: "This email is the invoice.",
  },

  // Payments
  "invoice.vendor_paid": { category: "Payments", label: "Vendor reports paid", description: "The vendor marks the person's invoice paid; the person confirms when the money arrives.", groups: P },
  "payment_issue.opened": { category: "Payments", label: "Payment issue opened", description: "A deputy reports an invoice as not paid.", groups: S },
  "payment_issue.waiting_on": {
    category: "Payments",
    label: "Payment issue waiting on you",
    description: "A coordinator moves a payment issue to wait on the deputy, a coordinator or the vendor.",
    groups: ALL,
    emailOnlyGroups: ["vendor"],
    note: "Vendors get it by email at their billing addresses.",
  },
  "payment_issue.closed": { category: "Payments", label: "Payment issue closed", description: "A payment issue the person opened is closed.", groups: P },
  "payment_issue.overdue": { category: "Payments", label: "Payment issue overdue", description: "An invoice has been with the coordinators past their response time.", groups: S },
  "invoice.vendor_payment_reminder": {
    category: "Payments",
    label: "Payment reminder to the vendor",
    description: "A sent invoice is past the vendor's response time and not marked paid.",
    groups: ["vendor"],
    emailOnly: true,
    note: "Also needs vendor payment reminders on under Reminders and locks.",
  },
  "payment.issue_opened": { category: "Payments", label: "Payment issue opened", description: "Not sent at present.", groups: S, unused: true },

  // Vendor requests
  "vendor.request_submitted": { category: "Vendor requests", label: "Vendor request submitted", description: "A vendor submits a new detail request.", groups: S },
  "vendor.request_edited": { category: "Vendor requests", label: "Vendor request edited", description: "A vendor edits a request or a scheduled detail.", groups: S },
  "vendor.request_decided": { category: "Vendor requests", label: "Request decided", description: "A coordinator approves or declines the vendor's request or change.", groups: ["vendor"] },
  "vendor.contract_expiring": { category: "Vendor requests", label: "Vendor contract expiring", description: "A vendor's contract expires soon.", groups: S },

  // Ops plans
  "ops_plan.due_soon": { category: "Ops plans", label: "Ops plan due soon", description: "A detail's ops plan is due soon and not submitted.", groups: PS },
  "ops_plan.overdue": { category: "Ops plans", label: "Ops plan overdue", description: "A detail's ops plan is past due.", groups: PS },
  "ops_plan.submitted": { category: "Ops plans", label: "Ops plan submitted", description: "An ops plan is submitted for review.", groups: PS },
  "ops_plan.resubmitted": { category: "Ops plans", label: "Ops plan resubmitted", description: "A revised ops plan is submitted for review.", groups: PS },
  "ops_plan.review_waiting": { category: "Ops plans", label: "Ops plan waiting for review", description: "A submitted ops plan has not been reviewed, once a day.", groups: PS },
  "ops_plan.no_reviewers": { category: "Ops plans", label: "No ops plan reviewers", description: "An ops plan was submitted and no reviewer can review it.", groups: S },
  "ops_plan.agreed": { category: "Ops plans", label: "Ops plan agreed", description: "A reviewer agrees to an ops plan.", groups: PS },
  "ops_plan.denied": { category: "Ops plans", label: "Ops plan denied", description: "A reviewer denies an ops plan; the submitter revises it.", groups: P },
  "ops_plan.due": { category: "Ops plans", label: "Ops plan due", description: "Not sent at present.", groups: PS, unused: true },

  // Account
  "auth.sign_in_code": { category: "Account", label: "Sign-in code", description: "The 6-digit code emailed at each sign-in.", groups: ALL, emailOnly: true, locked: "Needed to sign in." },
  "auth.invite": { category: "Account", label: "Invitation", description: "The link to set up a new account.", groups: ALL, emailOnly: true, locked: "Needed to set up an account." },
  "auth.password_reset": { category: "Account", label: "Password reset", description: "The link to choose a new password, sent when someone asks for it.", groups: ALL, emailOnly: true, locked: "Needed to get back into an account." },
  "settings.email_replaced": {
    category: "Account",
    label: "Email server replaced",
    description: "Someone replaced the saved email server from the server's command line (setup-email --replace).",
    groups: S,
    locked: "A different email server could read sign-in codes and reset links.",
  },
  "settings.test_email": { category: "Account", label: "Test email", description: "Sent to an admin who tests the email settings.", groups: S, emailOnly: true, locked: "Sent only when an admin asks for it." },
  "message.received": {
    category: "Messages",
    label: "Message received",
    description: "Someone sends the person a message in the app.",
    groups: PS,
    note: "Messages from coordinators always arrive by email and push.",
  },
  "user.suspended": {
    category: "Account",
    label: "Account suspended",
    description: "A coordinator suspends the person's sign-ups.",
    groups: P,
    inAppOnly: "Suspensions are a personnel matter, so this is never emailed or pushed.",
  },
  "w9.approved": { category: "Account", label: "W-9 approved", description: "Staff approve the W-9 the person or staff uploaded.", groups: P, note: "Never sent to vendors." },
  "w9.rejected": { category: "Account", label: "W-9 not approved", description: "Staff reject a W-9, with the reason and a link to upload a new one.", groups: P, note: "Never sent to vendors." },
  "w9.renewal_requested": { category: "Account", label: "New W-9 requested", description: "Staff ask the person for a new W-9 by a due date.", groups: P, note: "Never sent to vendors." },
  "w9.renewal_reminder": { category: "Account", label: "New W-9 due soon", description: "A requested W-9 is still missing a week before, and the day before, the due date.", groups: P, note: "Never sent to vendors." },
  "access_review.reminder": { category: "Account", label: "Access review reminder", description: "The yearly access review still has accounts to decide.", groups: S },
};

/** The channels a group can get for this type: vendors and email-only types get email only. */
export function channelsFor(entry: CatalogEntry, group: RecipientGroup): readonly Channel[] {
  if (!entry.groups.includes(group) || entry.inAppOnly) return [];
  if (entry.emailOnly || group === "vendor" || entry.emailOnlyGroups?.includes(group)) return ["email"];
  return CHANNELS;
}

/** The group a recipient counts in for this type. Staff on a detail get detail alerts as personnel. */
export function groupFor(role: "admin" | "coordinator" | "personnel" | "vendor", entry: CatalogEntry): RecipientGroup {
  if (role === "vendor") return "vendor";
  const staff = role === "admin" || role === "coordinator";
  if (staff && entry.groups.includes("staff")) return "staff";
  if (entry.groups.includes("personnel")) return "personnel";
  return "staff";
}

/** Stored agency choices: type, then group, then channel. Anything missing is on. */
export type AgencyChannels = Partial<Record<string, Partial<Record<RecipientGroup, Partial<Record<Channel, boolean>>>>>>;

/** Whether the agency lets this channel go to this group for this type. Locked types are always on. */
export function agencyChannelOn(stored: AgencyChannels, key: CatalogKey, group: RecipientGroup, channel: Channel): boolean {
  const entry = CATALOG[key];
  if (entry.inAppOnly) return false;
  if (entry.locked) return true;
  return stored[key]?.[group]?.[channel] ?? true;
}

/** Why one group's stored channels for a type cannot be saved, or null. */
function groupChannelsProblem(entry: CatalogEntry, group: string, channels: Partial<Record<Channel, boolean>> | undefined): string | null {
  const allowed = (RECIPIENT_GROUPS as readonly string[]).includes(group) ? channelsFor(entry, group as RecipientGroup) : [];
  for (const [channel, on] of Object.entries(channels ?? {})) {
    if (!(allowed as readonly string[]).includes(channel)) return `${entry.label} has no ${channel} for ${GROUP_LABEL[group as RecipientGroup] ?? group}.`;
    if (entry.locked && on === false) return `${entry.label} cannot be turned off. ${entry.locked}`;
  }
  return null;
}

/** Why stored agency choices cannot be saved, or null. */
export function agencyChannelsProblem(stored: AgencyChannels): string | null {
  for (const [key, groups] of Object.entries(stored)) {
    const entry = (CATALOG as Record<string, CatalogEntry | undefined>)[key];
    if (!entry) return `Unknown notification type: ${key}.`;
    for (const [group, channels] of Object.entries(groups ?? {})) {
      const problem = groupChannelsProblem(entry, group, channels);
      if (problem) return problem;
    }
  }
  return null;
}
