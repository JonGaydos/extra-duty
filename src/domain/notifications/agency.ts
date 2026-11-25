import type { Tx } from "@/db/client";
import type { Actor, Role } from "../actor";
import { assertCan } from "../auth/policy";
import { getSettings, saveNotificationChannels } from "../settings/settings";
import { agencyChannelOn, CATALOG, channelsFor, groupFor, type AgencyChannels } from "./catalog";
import { NOTIFICATION_TYPES, type NotificationType } from "./types";

/** The agency's stored notification switches (anything missing is on). Coordinators and admins. */
export async function agencyNotificationSettings(actor: Actor, tx: Tx): Promise<{ channels: AgencyChannels }> {
  assertCan(actor, "settings.notifications");
  return { channels: (await getSettings(tx)).notificationChannels as AgencyChannels };
}

/** Changes the switches in `patch` (type, then group, then channel). Coordinators and admins; audited. */
export async function saveAgencyNotifications(actor: Actor, tx: Tx, patch: AgencyChannels): Promise<AgencyChannels> {
  return saveNotificationChannels(actor, tx, patch);
}

/** For a person's own alert page: the channels the agency turned off for their group, per type. */
export async function agencyTurnedOff(tx: Tx, role: Role): Promise<Partial<Record<NotificationType, { email: boolean; push: boolean }>>> {
  const stored = (await getSettings(tx)).notificationChannels as AgencyChannels;
  const out: Partial<Record<NotificationType, { email: boolean; push: boolean }>> = {};
  for (const type of NOTIFICATION_TYPES) {
    const entry = CATALOG[type];
    const group = groupFor(role, entry);
    const has = channelsFor(entry, group);
    const email = has.includes("email") && !agencyChannelOn(stored, type, group, "email");
    const push = has.includes("push") && !agencyChannelOn(stored, type, group, "push");
    if (email || push) out[type] = { email, push };
  }
  return out;
}
