import { currentMode } from "@/db/client";
import { appEnvFromProcess } from "@/lib/env";
import { guarded, outboxSender } from "./outbox";
import type { EmailSender } from "./types";

const notConfigured: EmailSender = {
  async send() {
    throw new Error("Email delivery is not configured.");
  },
};

// Kept on globalThis: Next compiles instrumentation and each route separately, so every bundle gets its
// own copy of this module, and a module-level variable would not be shared inside one Node process.
const KEY = Symbol.for("extra-duty.email-sender");
type Holder = { sender?: EmailSender };
const holder = ((globalThis as Record<symbol, unknown>)[KEY] ??= {}) as Holder;

/**
 * The app-wide sender. The app installs the settings-backed one (see ensureEmailSender). In training mode it is
 * always the outbox; on staging every message goes to the outbox except allowlisted sign-in email (keepInOutbox).
 */
export function getEmailSender(): EmailSender {
  if (currentMode() === "training") return outboxSender;
  const installed = holder.sender ?? notConfigured;
  return appEnvFromProcess() === "staging" ? guarded(() => installed) : installed;
}

export function setEmailSender(sender: EmailSender): void {
  holder.sender = sender;
}

/** True once any sender has been installed in this process. */
export function hasEmailSender(): boolean {
  return holder.sender !== undefined;
}
