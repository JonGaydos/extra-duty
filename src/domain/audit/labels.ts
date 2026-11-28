/** Plain labels for audit actions ("season.update" reads "Season changed"). The stable key is still shown. */

const EXACT: Record<string, string> = {
  "settings.update": "Settings changed",
  "jobs.release_recompute": "Release dates recalculated",
  "user.qualification_grant": "Special flag granted",
  "user.managed_vendors": "Vendors this person manages changed",
  "user.qualification_revoke": "Special flag revoked",
  "user.suspension_lift": "Suspension lifted",
  "assignment.suspension_remove": "Sign-up removed by suspension",
  "assignment.departure_remove": "Sign-up removed: left the agency",
  "assignment.write_off": "Unbilled detail written off",
  "user.reactivate": "Account reactivated",
  "user.contact_update": "Contact details changed",
  "user.invite_accepted": "Invite accepted",
  "user.theme_set": "Theme changed",
  "job.rate_override": "Rate approved outside the agency range",
  "job.rate_override_cleared": "Rate exception removed",
  "job.rate_changed": "Rate changed with people signed up",
  "email.test": "Test email sent",
  "auth.sign_in": "Signed in",
  "file.upload": "File uploaded",
  "access_review.decide": "Access review decision",
  "billing.lock_override": "Billing lock lifted",
  "w9.upload": "W-9 uploaded",
  "w9.read": "W-9 opened",
  "w9.approve": "W-9 approved",
  "w9.reject": "W-9 not approved",
  "w9.grandfather": "W-9 approved when review began",
  "w9.request": "New W-9 requested",
  "audit.export": "Audit log exported as CSV",
  "audit.print": "Audit Record printed",
  "audit.verify": "Audit Record checked",
  "message.acknowledge": "Message acknowledged",
  "message.ack_remind": "Acknowledgement reminder sent",
  "message.ack_export": "Acknowledgements exported",
};

const VERBS: Record<string, string> = {
  create: "added",
  update: "changed",
  delete: "deleted",
  activate: "turned on",
  deactivate: "turned off",
  approve: "approved",
  decline: "declined",
  deny: "denied",
  cancel: "canceled",
  edit: "edited",
  submit: "submitted",
  review: "reviewed",
  retire: "retired",
  invite: "invited",
  lock: "locked",
  unlock: "unlocked",
  suspend: "suspended",
  start: "started",
  complete: "completed",
  reorder: "reordered",
  send: "sent",
  close: "closed",
  export: "exported",
  print: "printed",
};

const words = (s: string) => s.replaceAll("_", " ");

export function auditLabel(action: string): string {
  if (EXACT[action]) return EXACT[action];
  const [entity, verb = ""] = action.split(".");
  const subject = words(entity);
  const done = VERBS[verb] ?? words(verb);
  const text = `${subject} ${done}`.trim();
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** The action types the audit log filters by, in plain words (owner decision 2026-11-27). */
export const AUDIT_GROUPS = [
  { key: "security", label: "Sign-ins and security" },
  { key: "details", label: "Details" },
  { key: "signups", label: "Sign-ups and assignments" },
  { key: "billing", label: "Billing and invoices" },
  { key: "payments", label: "Payments" },
  { key: "w9", label: "W-9s" },
  { key: "users", label: "Users and roles" },
  { key: "vendors", label: "Vendors" },
  { key: "settings", label: "Settings" },
  { key: "messages", label: "Messages" },
  { key: "exports", label: "Exports" },
  { key: "other", label: "Other" },
] as const;

export type AuditGroup = (typeof AUDIT_GROUPS)[number]["key"];

export const isAuditGroup = (v: string): v is AuditGroup => AUDIT_GROUPS.some((g) => g.key === v);

/** Exact actions that belong to a group other than their prefix's. */
const EXACT_GROUP: Record<string, AuditGroup> = {
  "user.lock": "security",
  "user.unlock": "security",
  "user.password_reset": "security",
  "user.invite_accepted": "security",
  "settings.sign_in_codes": "security",
  "settings.email_replaced": "security",
  "invoice.markPaid": "payments",
  "invoice.vendorMarkPaid": "payments",
  "invoice.close": "payments",
  "billing.lock_override": "signups",
  "job.watch": "signups",
  "job.unwatch": "signups",
  "job.watch_alerted": "signups",
  "job.watch_end": "signups",
  "data.export": "exports",
};

/** Groups by the action's first part, the record kind ("invoice.send" is billing). */
const PREFIX_GROUP: Record<string, AuditGroup> = {
  auth: "security",
  session: "security",
  api_key: "security",
  access_review: "security",
  calendar_token: "security",
  training: "security",
  job: "details",
  jobs: "details",
  job_attachment: "details",
  series: "details",
  ops_plan: "details",
  deputy_note: "details",
  assignment: "signups",
  spot_offer: "signups",
  invoice: "billing",
  invoice_batch: "billing",
  billing: "billing",
  paymentIssue: "payments",
  payment_issue: "payments",
  w9: "w9",
  w9_request: "w9",
  user: "users",
  rank: "users",
  qualification: "users",
  qualification_request: "users",
  position_type: "users",
  vendor: "vendors",
  vendorContact: "vendors",
  vendor_contact: "vendors",
  vendor_location: "vendors",
  vendor_document: "vendors",
  vendor_restriction: "vendors",
  settings: "settings",
  season: "settings",
  note_preset: "settings",
  email_message: "settings",
  email: "settings",
  notification: "settings",
  planning: "settings",
  saved_report: "settings",
  message: "messages",
  report: "exports",
  tax_summary: "exports",
  audit: "exports",
};

/** The plain-words group of an audit action. Any export (".export", ".print", "_export") is an export. */
export function auditGroup(action: string): AuditGroup {
  if (EXACT_GROUP[action]) return EXACT_GROUP[action];
  const [prefix, verb = ""] = action.split(".");
  if (verb === "export" || verb === "print" || verb.endsWith("_export")) return "exports";
  return PREFIX_GROUP[prefix] ?? "other";
}

/** Over this many entries a printed Audit Record needs confirmation; the screen suggests narrowing the filters. */
export const LARGE_PRINT = 2000;

export const DATE_PRESETS = [
  { key: "today", label: "Today" },
  { key: "7d", label: "Last 7 days" },
  { key: "30d", label: "Last 30 days" },
  { key: "year", label: "This year" },
  { key: "custom", label: "Custom" },
] as const;
export type DatePreset = (typeof DATE_PRESETS)[number]["key"];

export type AuditQuery = {
  doneBy?: string;
  about?: string;
  groups?: AuditGroup[];
  /** A detail number. */
  detail?: number;
  vendorId?: string;
  /** An invoice number: the digits of "ED-000123". */
  invoice?: number;
  preset?: DatePreset;
  /** Custom range, agency days (YYYY-MM-DD). */
  from?: string;
  to?: string;
  text?: string;
  /** Include actions the system took (no person). Default on. */
  system?: boolean;
  order?: "newest" | "oldest";
  /** A record's own history (the entity links in the log). */
  entityType?: string;
  entityId?: string;
};
