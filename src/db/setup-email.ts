/**
 * First-run email setup (ROLE=setup-email). Sign-in needs an emailed code, and the email server is normally set by
 * an admin inside the app, so on a new site nobody could sign in. This saves the SMTP server from SETUP_* variables,
 * as the first admin (SEED_ADMIN_EMAIL), audited like the in-app save. Afterwards the first admin uses "Forgot
 * password" on the sign-in page. Steps: docs/self-hosting.md, "First sign-in".
 *
 * Once an email server is saved it is refused, so the command cannot quietly redirect sign-in codes to another
 * server. `--replace` overrides that: the replacement is audited and every admin is alerted in the app and by email.
 */
import { and, eq, sql } from "drizzle-orm";
import { fileURLToPath } from "node:url";
import { createDb, type Db } from "./client";
import { users } from "./schema";
import { recordAudit } from "../domain/audit/audit";
import { loadActiveActor } from "../domain/auth/sign-in-policy";
import { emit } from "../domain/notifications/notify";
import { getSettings, updateSettings } from "../domain/settings/settings";
import { emailConfigProblem } from "../lib/email/provider";

type Env = Record<string, string | undefined>;

export async function setupEmail(db: Db, env: Env, opts: { replace?: boolean } = {}): Promise<void> {
  const need = (name: string) => {
    const v = env[name]?.trim();
    if (!v) throw new Error(`${name} is not set.`);
    return v;
  };
  const email = need("SEED_ADMIN_EMAIL").toLowerCase();
  const from = need("SETUP_EMAIL_FROM");
  const host = need("SETUP_SMTP_HOST");
  const port = Number(env.SETUP_SMTP_PORT?.trim() || "587");
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("SETUP_SMTP_PORT must be a port from 1 to 65535.");
  await db.transaction(async (tx) => {
    const [u] = await tx.select({ id: users.id }).from(users).where(eq(sql`lower(${users.email})`, email));
    const admin = u ? await loadActiveActor(tx, u.id) : null;
    if (!admin || admin.role !== "admin") throw new Error(`No active admin account for ${email}. Run the release step with SEED_ADMIN_EMAIL set first.`);
    const before = (await getSettings(tx)).email;
    const configured = emailConfigProblem(before) === null;
    if (configured && !opts.replace) {
      throw new Error(`An email server is already saved (${before.smtp.host || before.provider}). Change it in the app (Management, System, Email), or run this again with --replace.`);
    }
    await updateSettings(admin, tx, {
      email: {
        provider: "smtp",
        from,
        smtp: { host, port, secure: env.SETUP_SMTP_SECURE === "true", user: env.SETUP_SMTP_USER?.trim() ?? "", password: env.SETUP_SMTP_PASSWORD ?? "" },
      },
    });
    if (!configured) return;
    await recordAudit(tx, {
      actor: admin,
      action: "settings.email_replaced",
      entityType: "settings",
      entityId: "email",
      before: { provider: before.provider, host: before.smtp.host, from: before.from },
      after: { provider: "smtp", host, from },
      reason: "setup-email --replace from the server command line",
    });
    const admins = await tx.select({ id: users.id }).from(users).where(and(eq(users.role, "admin"), eq(users.active, true)));
    await emit(tx, {
      recipients: admins.map((a) => a.id),
      type: "settings.email_replaced",
      title: "The email server was replaced",
      body: `The saved email server was replaced from the server's command line: ${before.smtp.host || before.provider} is now ${host}. If no one at the agency did this, change it back in Management, System, Email and tell your IT staff.`,
      link: "/admin/system/email",
      mandatory: true,
    });
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL is not set");
    process.exit(1);
  }
  const db = createDb(url);
  setupEmail(db, process.env, { replace: process.argv.slice(2).includes("--replace") })
    .then(
      () => console.log("setup-email: the email server is saved. Sign in with Forgot password to set the first admin's password."),
      (err) => {
        console.error("setup-email failed:", err instanceof Error ? err.message : err);
        process.exitCode = 1;
      },
    )
    .finally(() => db.$client.end());
}
