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
