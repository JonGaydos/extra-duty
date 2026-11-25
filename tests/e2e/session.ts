import { createHmac, randomBytes } from "node:crypto";
import type { BrowserContext } from "@playwright/test";
import { Client } from "pg";
import { uuidv7 } from "uuidv7";
import { E2E, E2E_EXTRA_USERS, E2E_USERS, type E2EUser } from "./env";

/**
 * Test-side sign-in: writes a session row straight into the e2e database and
 * sets Better Auth's signed session cookie on the browser context. Nothing in
 * the app changes for tests; this runs only in the Playwright process.
 */
export async function signInAs(context: BrowserContext, who: E2EUser | keyof typeof E2E_EXTRA_USERS): Promise<void> {
  const email = who in E2E_USERS ? E2E_USERS[who as E2EUser].email : E2E_EXTRA_USERS[who as keyof typeof E2E_EXTRA_USERS].email;
  await signInEmail(context, email, who);
}

/** The same test-side sign-in for any account, by email. */
export async function signInEmail(context: BrowserContext, email: string, label: string = email): Promise<void> {
  const client = new Client({ connectionString: E2E.databaseURL });
  await client.connect();
  try {
    const { rows } = await client.query<{ id: string }>("select id from users where email = $1", [email]);
    if (!rows[0]) throw new Error(`No e2e user ${label}`);
    const token = randomBytes(24).toString("base64url");
    await client.query(
      "insert into sessions (id, token, user_id, expires_at, created_at, updated_at) values ($1, $2, $3, now() + interval '12 hours', now(), now())",
      [uuidv7(), token, rows[0].id],
    );
    const signature = createHmac("sha256", E2E.appEnv.BETTER_AUTH_SECRET).update(token).digest("base64");
    await context.addCookies([
      { name: "better-auth.session_token", value: `${token}.${signature}`, url: E2E.baseURL, httpOnly: true, sameSite: "Lax" },
    ]);
  } finally {
    await client.end();
  }
}
