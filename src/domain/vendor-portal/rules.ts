import type { AgencySettings } from "../settings/settings";

export { lateCancelMinutes } from "../billing/rules";

export type VendorSettings = Pick<AgencySettings, "vendorEditLockHours" | "vendorEditsAfterSignup" | "vendorCancelUntilHours">;
export type VendorChange = "time" | "date" | "headcount_up" | "headcount_down" | "description" | "cancel";
export type EditDecision = { allowed: boolean; needsApproval: boolean; reason?: string };

const HOUR_MS = 3_600_000;
const refuse = (reason: string): EditDecision => ({ allowed: false, needsApproval: false, reason });

/**
 * What a vendor may do to an approved job (spec 8). A cancel is allowed until `vendorCancelUntilHours`
 * before the start and never at or after it. Every other change is refused inside the edit lock window and,
 * once someone is signed up, unless the setting allows adding positions. Time, date and headcount changes
 * go back to a coordinator.
 */
export function vendorEditAllowed(input: {
  now: Date;
  job: { startAt: Date; signedUpCount: number };
  change: VendorChange;
  s: VendorSettings;
}): EditDecision {
  const { now, job, change, s } = input;
  const hoursAhead = (job.startAt.getTime() - now.getTime()) / HOUR_MS;
  if (change === "cancel") {
    if (hoursAhead <= 0) return refuse("A detail that has started cannot be canceled.");
    if (hoursAhead < s.vendorCancelUntilHours) return refuse(`Cancellations close ${s.vendorCancelUntilHours} hours before the start. Call the coordinators.`);
    return { allowed: true, needsApproval: false };
  }
  if (hoursAhead < s.vendorEditLockHours) return refuse(`Changes are not allowed within ${s.vendorEditLockHours} hours of the start. Call the coordinators.`);
  if (job.signedUpCount > 0) {
    const onlyMore = s.vendorEditsAfterSignup === "add_positions" && change === "headcount_up";
    if (!onlyMore) {
      return refuse(
        s.vendorEditsAfterSignup === "add_positions"
          ? "Someone is signed up, so only adding positions is allowed. Call the coordinators."
          : "Someone is signed up, so this detail cannot be changed. Call the coordinators.",
      );
    }
  }
  return { allowed: true, needsApproval: change !== "description" };
}

/**
 * The sign-ups that fill a spot, as a vendor sees it: the detail list and the detail itself use this one rule, so
 * the list never says "filled" while the names stay hidden. A pending short request and a no-show do not fill one.
 */
export const VENDOR_FILLED = ["signed_up", "billed", "paid"] as const;
