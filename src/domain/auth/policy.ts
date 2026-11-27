import type { Actor, Role } from "@/domain/actor";
import { ForbiddenError } from "@/domain/errors";

type Level = "personnel" | "coordinator" | "admin";
type Rule =
  | { min: Level }
  | { min: Level; ownerScoped: true }
  | { min: Level; vendorScoped: true }
  | { vendorOnly: true };

// Admin includes coordinator powers; coordinator includes personnel powers.
// Vendors hold no tier and act only through vendor-scoped rules.
const RULES = {
  "job.read": { min: "personnel", vendorScoped: true },
  "job.create": { min: "coordinator" },
  "job.update": { min: "coordinator" },
  "job.cancel": { min: "coordinator" },
  "job.reactivate": { min: "coordinator" },
  "job.signup": { min: "personnel" },
  "job.backup": { min: "personnel" },
  "job.watch": { min: "personnel" },
  "assignment.cancelOwn": { min: "personnel", ownerScoped: true },
  "assignment.assign": { min: "coordinator" },
  "assignment.remove": { min: "coordinator" },
  "assignment.noShow": { min: "coordinator" },
  "assignment.writeOff": { min: "coordinator" },
  "invoice.billOwn": { min: "personnel", ownerScoped: true },
  "invoice.review": { min: "coordinator" },
  "invoice.markPaidOwn": { min: "personnel", ownerScoped: true },
  "invoice.vendorMarkPaid": { vendorOnly: true },
  "invoice.close": { min: "coordinator" },
  "billing.overrideLock": { min: "coordinator" },
  "paymentIssue.report": { min: "personnel" },
  "paymentIssue.manage": { min: "coordinator" },
  "w9.read": { min: "personnel", ownerScoped: true },
  "w9.uploadOwn": { min: "personnel", ownerScoped: true },
  /** Staff upload a W-9 for a person, and approve or reject W-9s. */
  "w9.uploadFor": { min: "coordinator" },
  "w9.review": { min: "coordinator" },
  "user.manage": { min: "coordinator" },
  "user.suspend": { min: "coordinator" },
  "rank.manage": { min: "coordinator" },
  "qualification.manage": { min: "coordinator" },
  "qualification.request": { min: "personnel" },
  "vendor.manage": { min: "coordinator" },
  "vendor.read": { min: "coordinator", vendorScoped: true },
  "vendor.paymentHold": { min: "coordinator" },
  "vendorLocation.manageOwn": { min: "coordinator", vendorScoped: true },
  "vendorContact.manage": { min: "coordinator", vendorScoped: true },
  "vendorRequest.submit": { min: "coordinator", vendorScoped: true },
  "vendorRequest.decide": { min: "coordinator" },
  "vendorJob.view": { min: "coordinator", vendorScoped: true },
  "vendorJob.edit": { min: "coordinator", vendorScoped: true },
  "vendorJob.cancel": { min: "coordinator", vendorScoped: true },
  "vendorRestriction.manage": { min: "coordinator" },
  "lateCancel.waive": { min: "coordinator" },
  "audit.read": { min: "coordinator" },
  "settings.read": { min: "coordinator" },
  "settings.update.rules": { min: "coordinator" },
  "settings.update.system": { min: "admin" },
  /** The agency's Email and Push switches per notification type and recipient group. */
  "settings.notifications": { min: "coordinator" },
  "season.manage": { min: "coordinator" },
  "report.run": { min: "coordinator" },
  "earnings.read": { min: "personnel", ownerScoped: true },
  "planning.manageOwn": { min: "personnel", ownerScoped: true },
  "profile.updateOwn": { min: "personnel", ownerScoped: true },
  "message.send": { min: "personnel" },
  "message.sendAll": { min: "personnel" },
  "opsPlan.submit": { min: "personnel" },
  "deputyNote.submit": { min: "personnel" },
  "deputyNote.manage": { min: "coordinator" },
  "apiKey.manage": { min: "admin" },
  /** The data API and full export: every record, so admins (and admin-made API keys) only. */
  "data.readAll": { min: "admin" },
  "training.switch": { min: "coordinator" },
  "training.reset": { min: "coordinator" },
  /** The outbox (training mode and staging) holds every unsent email, so staff only. */
  "training.outbox": { min: "coordinator" },
} as const satisfies Record<string, Rule>;

export type Action = keyof typeof RULES;
export const ACTIONS = Object.keys(RULES) as readonly Action[];

export type PolicyContext = { ownerUserId?: string; vendorId?: string };

const LEVEL: Record<Role, number> = { vendor: 0, personnel: 1, coordinator: 2, admin: 3 };
const MIN: Record<Level, number> = { personnel: 1, coordinator: 2, admin: 3 };

function vendorMatches(actor: Actor, ctx?: PolicyContext): boolean {
  return actor.vendorId !== null && ctx?.vendorId !== undefined && ctx.vendorId === actor.vendorId;
}

export function can(actor: Actor, action: Action, ctx?: PolicyContext): boolean {
  const rule: Rule = RULES[action];
  if ("vendorOnly" in rule) return actor.role === "vendor" && vendorMatches(actor, ctx);
  if (actor.role === "vendor") return "vendorScoped" in rule && vendorMatches(actor, ctx);
  if (LEVEL[actor.role] < MIN[rule.min]) return false;
  if ("ownerScoped" in rule && actor.role === "personnel") {
    return ctx?.ownerUserId !== undefined && ctx.ownerUserId === actor.userId;
  }
  return true;
}

export function assertCan(actor: Actor, action: Action, ctx?: PolicyContext): void {
  if (!can(actor, action, ctx)) throw new ForbiddenError();
}
