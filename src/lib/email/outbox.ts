import { currentMode, db } from "@/db/client";
import { trainingOutbox } from "@/db/schema";
import { appEnvFromProcess } from "@/lib/env";
import type { EmailSender, OutgoingEmail } from "./types";

/** True in training mode and on staging: email is kept in the outbox (on staging, all but allowlisted sign-in email). */
export function outboxActive(): boolean {
  return currentMode() === "training" || appEnvFromProcess() === "staging";
}

/** STAGING_EMAIL_ALLOWLIST: comma-separated addresses, compared without case. */
function stagingAllowlist(): Set<string> {
  return new Set(
    (process.env.STAGING_EMAIL_ALLOWLIST ?? "")
      .split(",")
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean),
  );
}

/**
 * Whether `msg` goes to the outbox instead of a mail server. Training: always. Staging: always, except a sign-in
 * email (code, invite, password reset) whose every recipient is on STAGING_EMAIL_ALLOWLIST, so testers can sign in.
 * Production: never.
 */
export function keepInOutbox(msg: OutgoingEmail): boolean {
  if (currentMode() === "training") return true;
  if (appEnvFromProcess() !== "staging") return false;
  const allow = stagingAllowlist();
  return !(msg.auth && msg.to.length > 0 && msg.to.every((to) => allow.has(to.trim().toLowerCase())));
}

/** Keeps the message in the current database's outbox (training_outbox). It never opens a connection to a mail server. */
export const outboxSender: EmailSender = {
  async send(msg) {
    await db.insert(trainingOutbox).values({
      to: msg.to,
      replyTo: msg.replyTo ?? null,
      subject: msg.subject,
      text: msg.text,
      html: msg.html,
      attachments: (msg.attachments ?? []).map((a) => ({ filename: a.filename, contentType: a.contentType, size: a.content.length })),
    });
  },
};

/** `real` for the messages allowed out (see keepInOutbox), the outbox for everything else. */
export function guarded(real: () => EmailSender): EmailSender {
  return {
    async send(msg) {
      if (keepInOutbox(msg)) return outboxSender.send(msg);
      return real().send(msg);
    },
  };
}
