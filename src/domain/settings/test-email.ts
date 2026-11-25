import { eq } from "drizzle-orm";
import type { Tx } from "@/db/client";
import { users } from "@/db/schema";
import { simpleEmail } from "@/lib/email/format";
import { emailConfigProblem, senderFromSettings } from "@/lib/email/provider";
import type { EmailSender } from "@/lib/email/types";
import type { Actor } from "../actor";
import { recordAudit } from "../audit/audit";
import { assertCan } from "../auth/policy";
import { ValidationError } from "../errors";
import { getSettings, type AgencySettings } from "./settings";

/** Runs `fn` in its own short transaction (the app's withTx, or a test database's). */
export type RunTx = <T>(fn: (tx: Tx) => Promise<T>) => Promise<T>;

/**
 * Sends one message to the admin's own address through the saved email settings, right away (not queued), so
 * the admin sees at once whether the provider accepts it. The send happens outside any transaction, so a slow
 * or unreachable server never holds a database connection; the audit row is written after. Returns the address.
 */
export async function sendTestEmail(
  actor: Actor,
  run: RunTx,
  makeSender: (e: AgencySettings["email"]) => EmailSender = senderFromSettings,
): Promise<string> {
  assertCan(actor, "settings.update.system");
  const { s, me } = await run(async (tx) => ({
    s: await getSettings(tx),
    me: (await tx.select({ email: users.email, name: users.name }).from(users).where(eq(users.id, actor.userId)))[0],
  }));
  const problem = emailConfigProblem(s.email);
  if (problem) throw new ValidationError(`Set ${problem.what} and save before sending a test.`);
  const msg = simpleEmail(me.email, "Extra Duty test email", [
    `This test was sent by ${me.name} from Extra Duty.`,
    `Email for ${s.agency.name} goes out through ${s.email.provider === "smtp" ? `the email server ${s.email.smtp.host}` : `the ${s.email.provider} provider`}. If you can read this, it works.`,
  ]);
  try {
    await makeSender(s.email).send(msg);
  } catch (e) {
    const why = e instanceof Error ? e.message.slice(0, 300) : "unknown error";
    throw new ValidationError(`The test email was not sent: ${why}`);
  }
  await run((tx) => recordAudit(tx, { actor, action: "email.test", entityType: "settings", entityId: "email", after: { to: me.email, provider: s.email.provider } }));
  return me.email;
}
