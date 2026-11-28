import { CATALOG, GROUP_LABEL, type CatalogEntry } from "../notifications/catalog";
import { NOTIFICATION_TYPES, type NotificationType } from "../notifications/types";
import type { PlaceholderKey } from "./placeholders";

/**
 * Every email the app sends, as an editable message (owner decision 2026-11-27): a default subject and body, the
 * placeholders it may use, the ones it must keep, and who may edit it. The built-in wording is the default, so nothing
 * changes until someone edits a message. Push and in-app wording stay short and fixed.
 */

export type MessageDef = {
  group: string;
  label: string;
  /** Who receives it, in plain words. */
  who: string;
  /** When it goes out, in one line. */
  when: string;
  subject: string;
  body: string;
  placeholders: readonly PlaceholderKey[];
  /** Placeholders that must stay in the message, with the refusal when one is missing. */
  required?: ReadonlyArray<{ key: PlaceholderKey; message: string }>;
  /** Sign-in, invite, password reset and security alerts: admins edit them, coordinators see them read-only. */
  adminOnly?: true;
  /** A confidential-detail variant: only the date and time of the detail may appear. */
  confidential?: true;
  /** Never emailed at present (unused or in-app-only types): kept for completeness, not listed. */
  hidden?: true;
};

const BASE: readonly PlaceholderKey[] = ["person.firstName", "person.name", "agency.name"];
const ALERT: readonly PlaceholderKey[] = [...BASE, "alert.title", "alert.body", "link"];
const CONFIDENTIAL: readonly PlaceholderKey[] = ["person.firstName", "agency.name", "detail.date", "detail.time", "link"];
const ALERT_BODY = "{{alert.body}}\n\nOpen in Signal 90: {{link}}";

/** Groups in the order the Email messages list shows them. */
export const MESSAGE_GROUPS = [
  "Sign-in and account",
  "Detail reminders",
  "Details",
  "Confidential details",
  "Sign-ups",
  "Invoices to vendors",
  "Billing and invoices",
  "Payments",
  "Vendor requests",
  "Ops plans",
  "Messages",
  "Account alerts",
] as const;

const whoOf = (e: CatalogEntry) => e.groups.map((g) => GROUP_LABEL[g]).join(", ");

/** The emails sent outside the alert list, and the alerts with fuller emails. */
const SPECIAL = {
  "auth.sign_in_code": {
    group: "Sign-in and account",
    label: "Sign-in code",
    who: "Anyone signing in",
    when: CATALOG["auth.sign_in_code"].description,
    subject: "Your sign-in code",
    body: "Your Signal 90 sign-in code is {{code}}.\n\nIt expires in {{code.minutes}} minutes. If you did not try to sign in, reset your password.",
    placeholders: ["agency.name", "code", "code.minutes"],
    required: [{ key: "code", message: "The sign-in code must stay in this message." }],
    adminOnly: true,
  },
  "auth.invite": {
    group: "Sign-in and account",
    label: "Invitation",
    who: "A new account holder",
    when: CATALOG["auth.invite"].description,
    subject: "Set up your Signal 90 account",
    body: "{{agency.name}} has created a Signal 90 account for you.\n\nUse this link to set your password. It works once and expires in 7 days.\n\n{{invite.link}}\n\nAfter you set your password, each sign-in also needs a 6-digit code sent to this email address.",
    placeholders: ["agency.name", "invite.link"],
    required: [{ key: "invite.link", message: "The account setup link must stay in this message." }],
    adminOnly: true,
  },
  "auth.password_reset": {
    group: "Sign-in and account",
    label: "Password reset",
    who: "Anyone who asks for a new password",
    when: CATALOG["auth.password_reset"].description,
    subject: "Reset your password",
    body: "Use this link to set a new Signal 90 password. It also unlocks an account locked for inactivity.\n\n{{reset.link}}\n\nThe link expires in 1 hour. If you did not ask for this, ignore this email.",
    placeholders: ["agency.name", "reset.link"],
    required: [{ key: "reset.link", message: "The password reset link must stay in this message." }],
    adminOnly: true,
  },
  "settings.test_email": {
    group: "Sign-in and account",
    label: "Test email",
    who: "The admin who sends it",
    when: CATALOG["settings.test_email"].description,
    subject: "Signal 90 test email",
    body: "This test was sent by {{person.name}} from Signal 90.\n\nEmail for {{agency.name}} goes out through {{email.route}}. If you can read this, it works.",
    placeholders: ["person.name", "agency.name", "email.route"],
    adminOnly: true,
  },
  "settings.email_replaced": {
    group: "Sign-in and account",
    label: "Email server replaced",
    who: GROUP_LABEL.staff,
    when: CATALOG["settings.email_replaced"].description,
    subject: "{{alert.title}}",
    body: ALERT_BODY,
    placeholders: ALERT,
    adminOnly: true,
  },
  "job.reminder": {
    group: "Detail reminders",
    label: "Detail reminder",
    who: "The people assigned, offered spots included",
    when: "At each reminder time before the start, set under Reminders and locks or on the detail.",
    subject: "Reminder: Detail #{{detail.number}} {{detail.title}} on {{detail.date}}",
    body: [
      "Reminder: you are on Detail #{{detail.number}}, {{detail.title}}, for {{vendor.name}}. It starts in {{reminder.hours}} hours.",
      "When: {{detail.date}}, {{detail.time}} (agency time)",
      "Where: {{detail.location}}",
      "Open in Maps: {{detail.mapsLink}}",
      "Position: {{detail.position}}. Pay: {{detail.pay}}",
      "About the detail: {{detail.description}}",
      "Note: {{reminder.note}}",
      "Officer safety: {{detail.safety}}",
      "Site contact: {{detail.contact}}",
      "Open in Signal 90: {{link}}",
    ].join("\n\n"),
    placeholders: [
      ...BASE,
      "detail.number",
      "detail.title",
      "detail.date",
      "detail.time",
      "detail.location",
      "detail.mapsLink",
      "detail.description",
      "detail.position",
      "detail.pay",
      "detail.safety",
      "detail.contact",
      "reminder.hours",
      "reminder.note",
      "vendor.name",
      "link",
    ],
  },
  "job.reminder.confidential": {
    group: "Detail reminders",
    label: "Detail reminder, confidential detail",
    who: "The people assigned to a confidential detail",
    when: "At each reminder time before a confidential detail starts. Says only the date and time.",
    subject: "Reminder: confidential detail on {{detail.date}}",
    body: "Reminder: you are assigned to a confidential detail on {{detail.date}} at {{detail.time}}. Open Signal 90 for the details.\n\nOpen in Signal 90: {{link}}",
    placeholders: CONFIDENTIAL,
    confidential: true,
  },
  "confidential.assigned": {
    group: "Confidential details",
    label: "Assigned to a confidential detail",
    who: GROUP_LABEL.personnel,
    when: "A coordinator assigns the person to a confidential detail. Says only the date.",
    subject: "Confidential detail on {{detail.date}}",
    body: "You were assigned to a confidential detail on {{detail.date}}. Open Signal 90 for the details.\n\nOpen in Signal 90: {{link}}",
    placeholders: CONFIDENTIAL,
    confidential: true,
  },
  "confidential.update": {
    group: "Confidential details",
    label: "Update about a confidential detail",
    who: "Coordinators, admins and the people assigned",
    when: "Any other alert about a confidential detail. Says only the date.",
    subject: "Confidential detail on {{detail.date}}",
    body: "There is an update about a confidential detail on {{detail.date}}. Open Signal 90 for the details.\n\nOpen in Signal 90: {{link}}",
    placeholders: CONFIDENTIAL,
    confidential: true,
  },
  "invoice.delivery": {
    group: "Invoices to vendors",
    label: "Invoice to the vendor",
    who: "The vendor's billing addresses",
    when: "An invoice is approved and sent, or staff resend it (with an optional extra address).",
    subject: "Invoice {{invoice.number}} for Detail #{{detail.number}}",
    body: "{{agency.name}} is sending invoice {{invoice.number}} for Detail #{{detail.number}}, worked by {{invoice.payee}}.\n\nAmount due: {{invoice.amount}}. The invoice is attached as a PDF.\n\n{{invoice.w9Line}}\n\nReply to this message with any billing questions.",
    placeholders: ["agency.name", "vendor.name", "invoice.number", "invoice.amount", "invoice.payee", "detail.number", "invoice.w9Line"],
    required: [
      { key: "invoice.number", message: "The invoice number must stay in this message." },
      { key: "invoice.amount", message: "The amount due must stay in this message." },
    ],
  },
  "invoice.revised": {
    group: "Invoices to vendors",
    label: "Revised invoice to the vendor",
    who: "The vendor's billing addresses",
    when: "A corrected invoice is sent after an earlier copy.",
    subject: "Revised invoice {{invoice.number}} for Detail #{{detail.number}}",
    body: "{{agency.name}} is sending revised invoice {{invoice.number}} for Detail #{{detail.number}}, worked by {{invoice.payee}}.\n\nThis is revision {{invoice.revision}} and replaces any earlier copy.\n\nAmount due: {{invoice.amount}}. The invoice is attached as a PDF.\n\n{{invoice.w9Line}}\n\nReply to this message with any billing questions.",
    placeholders: ["agency.name", "vendor.name", "invoice.number", "invoice.amount", "invoice.payee", "invoice.revision", "detail.number", "invoice.w9Line"],
    required: [
      { key: "invoice.number", message: "The invoice number must stay in this message." },
      { key: "invoice.amount", message: "The amount due must stay in this message." },
    ],
  },
  "invoice.batch": {
    group: "Invoices to vendors",
    label: "Invoice batch cover email",
    who: "The vendor's billing addresses",
    when: "A vendor's batched invoices go out on their send day, with a summary and every invoice attached.",
    subject: "{{batch.count}} from {{agency.name}}",
    body: "{{agency.name}} is sending {{batch.count}} to {{vendor.name}}.\n\nTotal due: {{invoice.amount}}. {{batch.paidNote}} A summary and each invoice are attached as PDFs. Pay each {{batch.payWord}} to the payee named on it.\n\n{{batch.w9Lines}}\n\nReply to this message with any billing questions.",
    placeholders: ["agency.name", "vendor.name", "batch.count", "invoice.amount", "batch.paidNote", "batch.payWord", "batch.w9Lines"],
    required: [
      { key: "batch.count", message: "The number of invoices must stay in this message." },
      { key: "invoice.amount", message: "The total due must stay in this message." },
    ],
  },
  "invoice.vendor_payment_reminder": {
    group: "Invoices to vendors",
    label: "Payment reminder to the vendor",
    who: "The vendor's billing addresses",
    when: `${CATALOG["invoice.vendor_payment_reminder"].description} ${CATALOG["invoice.vendor_payment_reminder"].note}`,
    subject: "Payment reminder: invoice {{invoice.number}}",
    body: "{{agency.name}}: This invoice has not been marked paid and is past its response time.\n\nInvoice: {{invoice.number}}\n\nJob: {{invoice.detail}}\n\nAmount: {{invoice.amount}}\n\nPayee: {{invoice.payee}}\n\nIf you have already paid, please mark it paid in the vendor portal.",
    placeholders: ["agency.name", "vendor.name", "invoice.number", "invoice.amount", "invoice.payee", "invoice.detail"],
    required: [
      { key: "invoice.number", message: "The invoice number must stay in this message." },
      { key: "invoice.amount", message: "The amount must stay in this message." },
    ],
  },
  "payment_issue.vendor": {
    group: "Invoices to vendors",
    label: "Payment issue waiting on the vendor",
    who: "The vendor's billing addresses",
    when: "A coordinator moves a payment issue to wait on the vendor.",
    subject: "Payment issue: invoice {{invoice.number}}",
    body: "{{agency.name}}: A payment issue on this invoice is waiting on you.\n\nInvoice: {{invoice.number}}\n\nJob: {{invoice.detail}}\n\nAmount: {{invoice.amount}}\n\nPayee: {{invoice.payee}}\n\nNote: {{invoice.note}}",
    placeholders: ["agency.name", "vendor.name", "invoice.number", "invoice.amount", "invoice.payee", "invoice.detail", "invoice.note"],
    required: [{ key: "invoice.number", message: "The invoice number must stay in this message." }],
  },
} as const satisfies Record<string, MessageDef>;

/** The group of an alert's email: its catalog category, with account alerts kept apart from sign-in emails. */
const groupOfAlert = (e: CatalogEntry) => (e.category === "Account" ? "Account alerts" : e.category);

/** Every other alert type: its email is the alert's title and text. Unused and in-app-only types are not listed. */
const ALERT_TYPES = NOTIFICATION_TYPES.filter((t) => !(t in SPECIAL));

type AlertKey = Exclude<(typeof ALERT_TYPES)[number], keyof typeof SPECIAL>;
export type MessageKey = keyof typeof SPECIAL | AlertKey;

const ALERTS = Object.fromEntries(
  ALERT_TYPES.map((t) => {
    const e = CATALOG[t];
    const def: MessageDef = {
      group: groupOfAlert(e),
      label: e.label,
      who: whoOf(e),
      when: e.description,
      subject: "{{alert.title}}",
      body: ALERT_BODY,
      placeholders: ALERT,
      ...(e.unused || e.inAppOnly ? { hidden: true as const } : {}),
    };
    return [t, def];
  }),
) as Record<AlertKey, MessageDef>;

export const MESSAGES: Record<MessageKey, MessageDef> = { ...SPECIAL, ...ALERTS };

export const isMessageKey = (k: string): k is MessageKey => Object.hasOwn(MESSAGES, k);

/** The message an alert's email uses. */
export function alertMessageKey(type: NotificationType): MessageKey {
  return type;
}
