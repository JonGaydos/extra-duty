/**
 * The placeholders an email message may use (owner decision 2026-11-27, editable email messages). Each one has a
 * label for the Insert placeholder buttons and a sample value for the preview and the test email. Link placeholders
 * become links in the HTML; every other value is escaped and never turned into a link.
 */

export const PLACEHOLDERS = {
  "person.firstName": { label: "First name", sample: "Jordan" },
  "person.name": { label: "Full name", sample: "Jordan Example" },
  "agency.name": { label: "Agency name", sample: "Example County Sheriff's Office" },
  link: { label: "Link to the app", sample: "https://signal90.example.org/jobs/0190a1b2", link: true },
  "alert.title": { label: "Alert title", sample: "Detail changed: #1042 Stadium security" },
  "alert.body": { label: "Alert text", sample: "The time changed to Dec 4, 2026, 5:00 PM to Dec 4, 2026, 11:00 PM." },
  "detail.number": { label: "Detail number", sample: "1042" },
  "detail.title": { label: "Detail title", sample: "Stadium security" },
  "detail.date": { label: "Date", sample: "Fri, Dec 4, 2026" },
  "detail.time": { label: "Time", sample: "5:00 PM to 11:00 PM" },
  "detail.location": { label: "Location", sample: "North Field, 100 Main St, Springfield" },
  "detail.mapsLink": { label: "Open in Maps link", sample: "https://www.openstreetmap.org/search?query=100%20Main%20St", link: true },
  "detail.description": { label: "Description", sample: "Traffic control at the north gate." },
  "detail.position": { label: "Position", sample: "Deputy Sheriff" },
  "detail.pay": { label: "Pay", sample: "$420 at $70/hr" },
  "detail.safety": { label: "Officer safety notes", sample: "Busy road, wear the vest." },
  "detail.contact": { label: "Site contact", sample: "Sam Site, 555-201-3344" },
  "reminder.hours": { label: "Hours before the start", sample: "24" },
  "reminder.note": { label: "Reminder note", sample: "Check in with the gate officer." },
  "vendor.name": { label: "Vendor name", sample: "Springfield Stadium" },
  "invoice.number": { label: "Invoice number", sample: "ED-1201" },
  "invoice.amount": { label: "Amount", sample: "$420.00" },
  "invoice.payee": { label: "Payee", sample: "Jordan Example" },
  "invoice.detail": { label: "Detail of the invoice", sample: "#1042, Stadium security" },
  "invoice.revision": { label: "Revision number", sample: "1" },
  "invoice.w9Line": { label: "W-9 line (when attached)", sample: "Jordan Example's W-9 is attached." },
  "invoice.note": { label: "Note to the vendor (when written)", sample: "Please send the check number." },
  "batch.count": { label: "Number of invoices", sample: "3 invoices" },
  "batch.paidNote": { label: "Already paid line (when any)", sample: "1 of them is already paid and marked Paid; nothing is due on it." },
  "batch.payWord": { label: "Invoices to pay", sample: "unpaid invoice" },
  "batch.w9Lines": { label: "W-9 lines (when attached)", sample: "W-9 for Jordan Example is attached." },
  code: { label: "Sign-in code", sample: "482913" },
  "code.minutes": { label: "Code lifetime in minutes", sample: "10" },
  "invite.link": { label: "Account setup link", sample: "https://signal90.example.org/accept-invite?token=sample", link: true },
  "reset.link": { label: "Password reset link", sample: "https://signal90.example.org/reset-password?token=sample", link: true },
  "email.route": { label: "How email goes out", sample: "the email server mail.example.org" },
} as const satisfies Record<string, { label: string; sample: string; link?: true }>;

export type PlaceholderKey = keyof typeof PLACEHOLDERS;
export type PlaceholderValues = Partial<Record<PlaceholderKey, string>>;

export const isPlaceholder = (k: string): k is PlaceholderKey => Object.hasOwn(PLACEHOLDERS, k);
export const isLinkPlaceholder = (k: PlaceholderKey) => "link" in PLACEHOLDERS[k];

/** Placeholders that name a detail's facts: never allowed in a confidential message, which says only the date and time. */
export const DETAIL_SECRETS: readonly PlaceholderKey[] = [
  "detail.number",
  "detail.title",
  "detail.location",
  "detail.mapsLink",
  "detail.description",
  "detail.position",
  "detail.pay",
  "detail.safety",
  "detail.contact",
  "reminder.note",
  "vendor.name",
  "alert.title",
  "alert.body",
];

/** The sample values, for the preview and the test email. */
export function sampleValues(): PlaceholderValues {
  return Object.fromEntries(Object.entries(PLACEHOLDERS).map(([k, v]) => [k, v.sample])) as PlaceholderValues;
}
