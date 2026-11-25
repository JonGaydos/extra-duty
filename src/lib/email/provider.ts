import { decryptSecret } from "@/lib/crypto/secrets";
import { currentMode } from "@/db/client";
import { appEnvFromProcess } from "@/lib/env";
import { guarded, keepInOutbox, outboxSender } from "./outbox";
import { mailgunSender, postmarkSender, sendgridSender, sesSender, smtpSender } from "./adapters";
import type { EmailSender } from "./types";

type EmailSettings = {
  provider: "smtp" | "postmark" | "ses" | "sendgrid" | "mailgun";
  from: string;
  smtp: { host: string; port: number; secure: boolean; user: string; passwordEnc: string };
  apiKeyEnc: string;
  region: string;
};

export type SettingsProblem = {
  code: "from_missing" | "smtp_host_missing" | "api_key_missing" | "api_key_invalid" | "region_missing" | "reply_to_missing";
  /** The email server settings are admin only, so a coordinator has to ask an admin. */
  adminOnly: boolean;
  /** What to set, as it reads inside a sentence. */
  what: string;
};

const problem = (code: SettingsProblem["code"], what: string, adminOnly = true): SettingsProblem => ({ code, adminOnly, what });

export const REPLY_TO_PROBLEM = problem("reply_to_missing", "the billing reply-to address", false);

/** The one place these messages are built. `purpose` completes "before ...", for example "sending invoices". */
export function settingsProblemMessage(p: SettingsProblem, purpose: string): string {
  return `${p.adminOnly ? "Ask an admin to set" : "Set"} ${p.what} in Settings before ${purpose}.`;
}

/** What must be set before mail can leave, or null when the provider is ready. */
export function emailConfigProblem(e: EmailSettings): SettingsProblem | null {
  if (!e.from.trim()) return problem("from_missing", "the sender address for outgoing email");
  if (e.provider === "smtp") {
    return e.smtp.host.trim() ? null : problem("smtp_host_missing", "the email server host");
  }
  if (!e.apiKeyEnc) return problem("api_key_missing", "the email provider API key");
  if (e.provider === "ses") {
    if (!e.region.trim()) return problem("region_missing", "the email provider region");
    let key = "";
    try {
      key = decryptSecret(e.apiKeyEnc);
    } catch {
      return problem("api_key_invalid", "the email provider API key");
    }
    if (!/^[^:\s]+:\S+$/.test(key)) {
      return problem("api_key_invalid", "the email provider API key in the form ACCESS_KEY_ID:SECRET_ACCESS_KEY");
    }
  }
  return null;
}

/**
 * Builds the adapter for the configured provider. Throws if the settings are incomplete. The outbox in training mode;
 * on staging the adapter is used only for allowlisted sign-in email (keepInOutbox), built when first needed.
 */
export function senderFromSettings(e: EmailSettings): EmailSender {
  if (currentMode() === "training") return outboxSender;
  if (appEnvFromProcess() === "staging") {
    let adapter: EmailSender | undefined;
    return guarded(() => (adapter ??= adapterFromSettings(e)));
  }
  return adapterFromSettings(e);
}

function adapterFromSettings(e: EmailSettings): EmailSender {
  const p = emailConfigProblem(e);
  if (p) throw new Error(settingsProblemMessage(p, "sending email"));
  switch (e.provider) {
    case "smtp":
      return smtpSender(e.from, {
        host: e.smtp.host,
        port: e.smtp.port,
        secure: e.smtp.secure,
        user: e.smtp.user,
        password: e.smtp.passwordEnc ? decryptSecret(e.smtp.passwordEnc) : "",
      });
    case "postmark":
      return postmarkSender(e.from, decryptSecret(e.apiKeyEnc));
    case "sendgrid":
      return sendgridSender(e.from, decryptSecret(e.apiKeyEnc));
    case "mailgun":
      return mailgunSender(e.from, decryptSecret(e.apiKeyEnc), e.region);
    case "ses":
      return sesSender(e.from, decryptSecret(e.apiKeyEnc), e.region);
  }
}

/**
 * A sender that reads the email settings on every send and rebuilds the adapter only when they change,
 * so an admin's edit applies without a restart.
 */
export function createSettingsSender(load: () => Promise<EmailSettings>): EmailSender {
  let cached: { key: string; sender: EmailSender } | undefined;
  return {
    async send(msg) {
      // Checked on every send: one process serves live and training requests.
      if (keepInOutbox(msg)) return outboxSender.send(msg);
      const settings = await load();
      const key = JSON.stringify(settings);
      if (!cached || cached.key !== key) cached = { key, sender: senderFromSettings(settings) };
      await cached.sender.send(msg);
    },
  };
}
