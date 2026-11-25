import { withTx } from "@/db/client";
import { getSettings } from "@/domain/settings/settings";
import { createSettingsSender } from "@/lib/email/provider";
import { hasEmailSender, setEmailSender } from "@/lib/email/sender";

/**
 * Installs the sender that reads the email settings on each send, so an admin's change applies without
 * a restart. The worker calls it at startup.
 */
export function installEmailSender(): void {
  setEmailSender(createSettingsSender(async () => (await withTx(getSettings)).email));
}

/** Installs the settings-backed sender unless one is already set. Safe to call before every send. */
export function ensureEmailSender(): void {
  if (!hasEmailSender()) installEmailSender();
}
