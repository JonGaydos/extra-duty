import { beforeAll, describe, expect, test, vi } from "vitest";
import { and, eq, like } from "drizzle-orm";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { useTestDb } from "../../setup/test-db";
import { accounts, auditLog, authThrottle, invites, ranks, sessions, trainingOutbox, users, vendors, vendorUsers, verifications } from "@/db/schema";
import type { Actor } from "@/domain/actor";
import { acceptInvite, createInvite } from "@/domain/auth/invites";
import { getActor, requireActor } from "@/domain/auth/session";
import { ForbiddenError, UnauthenticatedError, ValidationError } from "@/domain/errors";
import { pruneThrottle, THROTTLE_WINDOW_MS } from "@/domain/auth/sign-in-policy";
import { DEFAULT_SETTINGS } from "@/domain/settings/defaults";
import { updateSettings } from "@/domain/settings/settings";
import { createAuth, getAuth, sendSignInCode, type Auth } from "@/lib/auth";
import { getEmailSender, setEmailSender } from "@/lib/email/sender";
import { createMemorySender, type OutgoingEmail } from "@/lib/email/types";
import { useEmailQueue } from "../../setup/email-queue";
import SignInPage from "@/app/(auth)/sign-in/page";
import { TwoFactorForm } from "@/app/(auth)/two-factor/two-factor-form";
import { GET as listJobsRoute } from "@/app/api/v1/jobs/route";

const BASE = process.env.BETTER_AUTH_URL!;
const PASSWORD = "correct horse battery";
const DAY = 86_400_000;

/** Minimal cookie jar: applies Set-Cookie headers and replays them as a Cookie header. */
class Jar {
  private cookies = new Map<string, string>();
  apply(headers: Headers | null | undefined): this {
    for (const line of headers?.getSetCookie() ?? []) {
      const [pair, ...attrs] = line.split(";");
      const i = pair.indexOf("=");
      const name = pair.slice(0, i).trim();
      const value = pair.slice(i + 1).trim();
      const expired = attrs.some((a) => /^\s*max-age=0\s*$/i.test(a));
      if (expired || value === "") this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
    return this;
  }
  has(fragment: string): boolean {
    return [...this.cookies.keys()].some((k) => k.includes(fragment));
  }
  drop(fragment: string): this {
    for (const k of [...this.cookies.keys()]) if (k.includes(fragment)) this.cookies.delete(k);
    return this;
  }
  headers(extra: Record<string, string> = {}): Headers {
    const h = new Headers(extra);
    const cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
    if (cookie) h.set("cookie", cookie);
    return h;
  }
}

async function authError(p: Promise<unknown>): Promise<{ code?: string; status?: number }> {
  try {
    await p;
  } catch (e) {
    const err = e as { body?: { code?: string }; statusCode?: number };
    return { code: err.body?.code, status: err.statusCode };
  }
  throw new Error("Expected the call to fail.");
}

function codeFrom(msg: OutgoingEmail | undefined): string {
  const m = msg?.text.match(/\b(\d{6})\b/);
  if (!m) throw new Error("No 6-digit code in the email.");
  return m[1];
}

/** The last Set-Cookie line for a cookie whose name contains `fragment`. */
function lastSetCookie(headers: Headers | null | undefined, fragment: string): string {
  const line = (headers?.getSetCookie() ?? []).filter((l) => l.split("=")[0].includes(fragment)).at(-1);
  if (!line) throw new Error(`No ${fragment} cookie set.`);
  return line;
}

describe("authentication", () => {
  const get = useTestDb();
  const { drain } = useEmailQueue(get);
  const mail = createMemorySender();
  let auth: Auth;
  let coordinator: Actor;
  let deputyRankId: string;

  beforeAll(async () => {
    process.env.DATABASE_URL = get().url;
    setEmailSender(mail);
    const { db } = get();
    const [rank] = await db.insert(ranks).values({ name: "Deputy Sheriff", sortOrder: 3 }).returning();
    deputyRankId = rank.id;
    const [c] = await db.insert(users).values({ name: "Coord", email: "coord@example.test", role: "coordinator" }).returning();
    coordinator = { userId: c.id, role: "coordinator", rankId: null, vendorId: null };
    auth = await getAuth();
  });

  const mailTo = (email: string) => mail.sent.filter((m) => m.to.includes(email));
  const lastMailTo = (email: string) => mailTo(email).at(-1);

  async function invite(email: string, values: Partial<typeof users.$inferInsert> = {}): Promise<{ id: string; token: string }> {
    const { db } = get();
    const [u] = await db
      .insert(users)
      .values({ name: email.split("@")[0], email, rankId: deputyRankId, ...values })
      .returning();
    await db.transaction((tx) => createInvite(coordinator, tx, u.id));
    await drain();
    const link = lastMailTo(email)?.text.match(/https?:\/\/\S+accept-invite\?token=([A-Za-z0-9_-]+)/);
    if (!link) throw new Error("No invite link in the email.");
    return { id: u.id, token: link[1] };
  }

  async function makeUser(email: string, values: Partial<typeof users.$inferInsert> = {}): Promise<string> {
    const { id, token } = await invite(email, values);
    await acceptInvite(token, PASSWORD);
    return id;
  }

  async function passwordStep(a: Auth, email: string, password: string, jar = new Jar()) {
    const { headers, response } = await a.api.signInEmail({
      body: { email, password },
      headers: jar.headers(),
      returnHeaders: true,
    });
    jar.apply(headers);
    return { jar, response: response as Record<string, unknown> };
  }

  async function verify(a: Auth, jar: Jar, code: string, trustDevice = false) {
    const { headers } = await a.api.verifyTwoFactorOTP({
      body: { code, trustDevice },
      headers: jar.headers(),
      returnHeaders: true,
    });
    jar.apply(headers);
  }

  async function fullSignIn(email: string, password = PASSWORD): Promise<Jar> {
    const { jar } = await passwordStep(auth, email, password);
    await auth.api.sendTwoFactorOTP({ headers: jar.headers(), body: {} });
    await verify(auth, jar, codeFrom(lastMailTo(email)));
    return jar;
  }

  /** Moves counted attempts out of the window; for "password" also every per-IP count of that email. */
  async function backdateThrottle(kind: string, key: string) {
    const at = new Date(Date.now() - 16 * 60_000);
    await get().db.update(authThrottle).set({ at }).where(and(eq(authThrottle.kind, kind), eq(authThrottle.key, key)));
    if (kind === "password") {
      await get().db.update(authThrottle).set({ at }).where(and(eq(authThrottle.kind, "password_ip"), like(authThrottle.key, `${key}|%`)));
    }
  }

  const wrongFor = (code: string) => (code === "000000" ? "111111" : "000000");

  async function http(path: string, body: unknown, ip: string, a: Auth = auth): Promise<Response> {
    return a.handler(
      new Request(`${BASE}/api/auth${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: BASE, "x-forwarded-for": ip },
        body: JSON.stringify(body),
      }),
    );
  }

  describe("invites", () => {
    test("only coordinators and admins can invite", async () => {
      const { db } = get();
      const [u] = await db.insert(users).values({ name: "X", email: "x-forbidden@example.test" }).returning();
      const personnel: Actor = { userId: u.id, role: "personnel", rankId: null, vendorId: null };
      await expect(db.transaction((tx) => createInvite(personnel, tx, u.id))).rejects.toBeInstanceOf(ForbiddenError);
    });

    test("an invite emails a one-time link valid for 7 days and is audited", async () => {
      const before = Date.now();
      const { id } = await invite("inv1@example.test");
      const { db } = get();
      const [row] = await db.select().from(invites).where(eq(invites.userId, id));
      expect(row.usedAt).toBeNull();
      expect(row.expiresAt.getTime() - before).toBeGreaterThanOrEqual(7 * DAY - 1000);
      expect(row.expiresAt.getTime() - before).toBeLessThanOrEqual(7 * DAY + 5000);
      expect(lastMailTo("inv1@example.test")?.text).toContain(`${BASE}/accept-invite?token=`);
      const audit = await db.select().from(auditLog).where(and(eq(auditLog.entityId, id), eq(auditLog.action, "user.invite")));
      expect(audit).toHaveLength(1);
      expect(JSON.stringify(audit[0])).not.toMatch(/token/i);
    });

    test("accepting sets the password; the link cannot be used again", async () => {
      const { id, token } = await invite("inv2@example.test");
      await acceptInvite(token, PASSWORD);
      const { db } = get();
      const [acct] = await db
        .select()
        .from(accounts)
        .where(and(eq(accounts.userId, id), eq(accounts.providerId, "credential")));
      expect(acct.password).toBeTruthy();
      expect(acct.password).not.toContain(PASSWORD);
      const [row] = await db.select().from(invites).where(eq(invites.userId, id));
      expect(row.usedAt).not.toBeNull();
      const { response } = await passwordStep(auth, "inv2@example.test", PASSWORD);
      expect(response.twoFactorRedirect).toBe(true);
      await expect(acceptInvite(token, "another long password")).rejects.toBeInstanceOf(ValidationError);
    });

    test("an invite expires after 7 days", async () => {
      const { id, token } = await invite("inv3@example.test");
      const { db } = get();
      await db
        .update(invites)
        .set({ expiresAt: new Date(Date.now() - 1000) })
        .where(eq(invites.userId, id));
      await expect(acceptInvite(token, PASSWORD)).rejects.toBeInstanceOf(ValidationError);
      const creds = await db.select().from(accounts).where(eq(accounts.userId, id));
      expect(creds).toHaveLength(0);
    });

    test("a password shorter than the setting is refused and the invite stays usable", async () => {
      const { id, token } = await invite("inv4@example.test");
      await expect(acceptInvite(token, "short")).rejects.toBeInstanceOf(ValidationError);
      const { db } = get();
      const [row] = await db.select().from(invites).where(eq(invites.userId, id));
      expect(row.usedAt).toBeNull();
      await acceptInvite(token, PASSWORD);
    });

    test("an unknown token is refused", async () => {
      await expect(acceptInvite("not-a-real-token", PASSWORD)).rejects.toBeInstanceOf(ValidationError);
    });
  });

  describe("two-factor sign-in", () => {
    test("every account requires two-factor by default", async () => {
      const { db } = get();
      const [u] = await db.insert(users).values({ name: "D", email: "default-2fa@example.test" }).returning();
      expect(u.twoFactorEnabled).toBe(true);
    });

    test("an account with two-factor switched off still has to enter a code", async () => {
      const email = "tf-off@example.test";
      const id = await makeUser(email);
      await get().db.update(users).set({ twoFactorEnabled: false }).where(eq(users.id, id));
      const { jar, response } = await passwordStep(auth, email, PASSWORD);
      expect(response.twoFactorRedirect).toBe(true);
      expect(await getActor(jar.headers())).toBeNull();
    });

    test("after a correct password the user must enter an emailed 6-digit code; getActor is null until then", async () => {
      const email = "tf1@example.test";
      const id = await makeUser(email);
      const { jar, response } = await passwordStep(auth, email, PASSWORD);
      expect(response.twoFactorRedirect).toBe(true);
      expect(response.twoFactorMethods).toEqual(["otp"]);
      expect(await getActor(jar.headers())).toBeNull();
      await expect(requireActor(jar.headers())).rejects.toBeInstanceOf(UnauthenticatedError);
      const { db } = get();
      expect(await db.select().from(sessions).where(eq(sessions.userId, id))).toHaveLength(0);

      const sentBefore = mailTo(email).length;
      await auth.api.sendTwoFactorOTP({ headers: jar.headers(), body: {} });
      expect(mailTo(email)).toHaveLength(sentBefore + 1);
      const code = codeFrom(lastMailTo(email));
      expect(code).toMatch(/^\d{6}$/);
      expect(await getActor(jar.headers())).toBeNull();

      const beforeVerify = Date.now();
      await verify(auth, jar, code);
      const actor = await getActor(jar.headers());
      expect(actor).toEqual({ userId: id, role: "personnel", rankId: deputyRankId, vendorId: null });
      expect(await requireActor(jar.headers())).toEqual(actor);
      const [u] = await db.select().from(users).where(eq(users.id, id));
      expect(u.lastSignInAt!.getTime()).toBeGreaterThanOrEqual(beforeVerify - 1000);
      const audit = await db.select().from(auditLog).where(and(eq(auditLog.entityId, id), eq(auditLog.action, "auth.sign_in")));
      expect(audit).toHaveLength(1);
    });

    test("lastSignInAt is not set by the password step alone", async () => {
      const email = "tf-last@example.test";
      const id = await makeUser(email);
      await passwordStep(auth, email, PASSWORD);
      const [u] = await get().db.select().from(users).where(eq(users.id, id));
      expect(u.lastSignInAt).toBeNull();
    });

    test("a vendor login's actor carries its vendor", async () => {
      const email = "vendor1@example.test";
      const id = await makeUser(email, { role: "vendor", rankId: null });
      const { db } = get();
      const [v] = await db.insert(vendors).values({ name: "Acme Events" }).returning();
      await db.insert(vendorUsers).values({ userId: id, vendorId: v.id });
      const jar = await fullSignIn(email);
      expect(await getActor(jar.headers())).toEqual({ userId: id, role: "vendor", rankId: null, vendorId: v.id });
    });

    test("a code older than 15 minutes is refused and a new code is needed", async () => {
      const email = "tf2@example.test";
      await makeUser(email);
      const { jar } = await passwordStep(auth, email, PASSWORD);
      await auth.api.sendTwoFactorOTP({ headers: jar.headers(), body: {} });
      const code = codeFrom(lastMailTo(email));
      const { db } = get();
      const otpRows = await db.select().from(verifications).where(like(verifications.identifier, "2fa-otp-%"));
      const row = otpRows.at(-1)!;
      const lifetime = row.expiresAt.getTime() - row.createdAt.getTime();
      expect(Math.abs(lifetime - 15 * 60_000)).toBeLessThan(5000);

      await db
        .update(verifications)
        .set({ expiresAt: new Date(Date.now() - 1000) })
        .where(eq(verifications.id, row.id));
      expect((await authError(verify(auth, jar, code))).code).toBe("OTP_HAS_EXPIRED");
      expect(await getActor(jar.headers())).toBeNull();

      await auth.api.sendTwoFactorOTP({ headers: jar.headers(), body: {} });
      await verify(auth, jar, codeFrom(lastMailTo(email)));
      expect(await getActor(jar.headers())).not.toBeNull();
    });

    test("a sixth attempt after five wrong codes is refused and a new code is needed", async () => {
      const email = "tf3@example.test";
      await makeUser(email);
      const { jar } = await passwordStep(auth, email, PASSWORD);
      await auth.api.sendTwoFactorOTP({ headers: jar.headers(), body: {} });
      const code = codeFrom(lastMailTo(email));
      const wrong = code === "000000" ? "111111" : "000000";
      for (let i = 0; i < 5; i++) {
        expect((await authError(verify(auth, jar, wrong))).code).toBe("INVALID_CODE");
      }
      expect((await authError(verify(auth, jar, code))).code).toBe("TOO_MANY_ATTEMPTS_REQUEST_NEW_CODE");
      expect(await getActor(jar.headers())).toBeNull();

      await auth.api.sendTwoFactorOTP({ headers: jar.headers(), body: {} });
      await verify(auth, jar, codeFrom(lastMailTo(email)));
      expect(await getActor(jar.headers())).not.toBeNull();
    });

    test("a trusted device skips the code for 30 days", async () => {
      const email = "tf4@example.test";
      const id = await makeUser(email);
      const { jar } = await passwordStep(auth, email, PASSWORD);
      await auth.api.sendTwoFactorOTP({ headers: jar.headers(), body: {} });
      await verify(auth, jar, codeFrom(lastMailTo(email)), true);
      const { db } = get();
      const [trust] = await db
        .select()
        .from(verifications)
        .where(and(eq(verifications.value, id), like(verifications.identifier, "trust-device-%")));
      expect(Math.abs(trust.expiresAt.getTime() - Date.now() - 30 * DAY)).toBeLessThan(60_000);

      jar.drop("session_token");
      expect(await getActor(jar.headers())).toBeNull();
      const { response } = await passwordStep(auth, email, PASSWORD, jar);
      expect(response.twoFactorRedirect).toBeUndefined();
      expect(await getActor(jar.headers())).not.toBeNull();
    });
  });

  describe("no authenticator app", () => {
    test("authenticator, backup-code and disable endpoints do not exist", async () => {
      for (const path of [
        "/two-factor/enable",
        "/two-factor/disable",
        "/two-factor/get-totp-uri",
        "/two-factor/verify-totp",
        "/two-factor/generate-backup-codes",
        "/two-factor/verify-backup-code",
        "/sign-up/email",
      ]) {
        const res = await http(path, { password: PASSWORD, code: "123456" }, "10.9.9.9");
        expect(res.status, path).toBe(404);
      }
    });

    test("no page mentions an authenticator app, TOTP, QR codes or backup codes", async () => {
      const dir = join(process.cwd(), "src/app/(auth)");
      const files = (await readdir(dir, { recursive: true })).filter((f) => /\.tsx?$/.test(String(f)));
      expect(files.length).toBeGreaterThan(0);
      for (const f of files) {
        const src = await readFile(join(dir, String(f)), "utf8");
        expect(src, String(f)).not.toMatch(/authenticator|totp|qr code|backup code/i);
      }
    });
  });

  describe("staging", () => {
    /** Staging's auth, sending through the app-wide sender as getAuth does. */
    const stagingAuth = () =>
      createAuth({ db: get().db, emailSender: { send: (m) => getEmailSender().send(m) }, security: DEFAULT_SETTINGS.security });
    const outboxTo = async (email: string) => (await get().db.select().from(trainingOutbox)).filter((m) => m.to.includes(email));

    async function onStaging<T>(allowlist: string, fn: () => Promise<T>): Promise<T> {
      process.env.APP_ENV = "staging";
      process.env.STAGING_EMAIL_ALLOWLIST = allowlist;
      try {
        return await fn();
      } finally {
        process.env.APP_ENV = "production";
        delete process.env.STAGING_EMAIL_ALLOWLIST;
      }
    }

    test("an allowlisted address receives its sign-in code by email and can sign in; no code is shown on screen", async () => {
      const email = "stage1@example.test";
      const id = await makeUser(email);
      await onStaging(" Other@Example.test, STAGE1@example.test ", async () => {
        const staging = stagingAuth();
        const { jar } = await passwordStep(staging, email, PASSWORD);
        const sentBefore = mailTo(email).length;
        await sendSignInCode(jar.headers(), staging);
        expect(mailTo(email)).toHaveLength(sentBefore + 1);
        await verify(staging, jar, codeFrom(lastMailTo(email)));
        expect((await staging.api.getSession({ headers: jar.headers() }))?.user.id).toBe(id);
      });
    });

    test("a code, reset link or invite to an address not on the allowlist goes to the outbox and is not sent", async () => {
      const email = "stage2@example.test";
      await makeUser(email);
      await onStaging("someone.else@example.test", async () => {
        const staging = stagingAuth();
        const { jar } = await passwordStep(staging, email, PASSWORD);
        const sentBefore = mailTo(email).length;
        await sendSignInCode(jar.headers(), staging);
        await staging.api.requestPasswordReset({ body: { email, redirectTo: "/reset-password" } });
        const { db } = get();
        const [u] = await db.insert(users).values({ name: "stage3", email: "stage3@example.test", rankId: deputyRankId }).returning();
        await db.transaction((tx) => createInvite(coordinator, tx, u.id));
        await drain();
        expect(mailTo(email)).toHaveLength(sentBefore);
        expect(mailTo("stage3@example.test")).toHaveLength(0);
        expect((await outboxTo(email)).map((m) => m.subject).sort()).toEqual(["Reset your password", "Your sign-in code"]);
        expect(await outboxTo("stage3@example.test")).toHaveLength(1);
      });
    });

    test("an invite to an allowlisted address is sent", async () => {
      const { db } = get();
      await onStaging("stage4@example.test", async () => {
        const [u] = await db.insert(users).values({ name: "stage4", email: "stage4@example.test", rankId: deputyRankId }).returning();
        await db.transaction((tx) => createInvite(coordinator, tx, u.id));
        await drain();
        expect(mailTo("stage4@example.test")).toHaveLength(1);
      });
    });

    test("anything that is not a sign-in email never leaves staging, even to an allowlisted address", async () => {
      await onStaging("ap@vendor.example", async () => {
        const sentBefore = mail.sent.length;
        await getEmailSender().send({ to: ["ap@vendor.example"], subject: "Invoice ED-000001", text: "t", html: "<p>t</p>", attachments: [{ filename: "ED-000001.pdf", content: Buffer.from("%PDF"), contentType: "application/pdf" }] });
        expect(mail.sent).toHaveLength(sentBefore);
        expect(await outboxTo("ap@vendor.example")).toHaveLength(1);
      });
    });

    test("production emails the code and never returns it", async () => {
      const email = "prod1@example.test";
      await makeUser(email);
      const { jar } = await passwordStep(auth, email, PASSWORD);
      const sentBefore = mailTo(email).length;
      await sendSignInCode(jar.headers());
      expect(mailTo(email)).toHaveLength(sentBefore + 1);
      const html = renderToStaticMarkup(createElement(TwoFactorForm, {}));
      expect(html).not.toMatch(/\b\d{6}\b/);
    });
  });

  describe("blocked accounts", () => {
    test("a deactivated user cannot sign in", async () => {
      const email = "gone@example.test";
      const id = await makeUser(email);
      const { db } = get();
      await db.update(users).set({ active: false }).where(eq(users.id, id));
      const err = await authError(passwordStep(auth, email, PASSWORD));
      expect(err.code).toBe("ACCOUNT_DISABLED");
      expect(err.status).toBe(403);
      expect(await db.select().from(sessions).where(eq(sessions.userId, id))).toHaveLength(0);
    });

    test("a deactivated user's existing session no longer yields an actor", async () => {
      const email = "gone2@example.test";
      const id = await makeUser(email);
      const jar = await fullSignIn(email);
      expect(await getActor(jar.headers())).not.toBeNull();
      await get().db.update(users).set({ active: false }).where(eq(users.id, id));
      expect(await getActor(jar.headers())).toBeNull();
    });

    test("a wrong password for a deactivated user gets the ordinary error", async () => {
      const email = "gone3@example.test";
      const id = await makeUser(email);
      await get().db.update(users).set({ active: false }).where(eq(users.id, id));
      expect((await authError(passwordStep(auth, email, "wrong password 123"))).code).toBe("INVALID_EMAIL_OR_PASSWORD");
    });

    test("an over-long email is refused before it is counted, so it never reaches the throttle table", async () => {
      const long = `${"a".repeat(400)}@example.test`;
      const res = await http("/sign-in/email", { email: long, password: "wrong password 123" }, "10.0.9.1");
      expect(res.status).toBe(400);
      const rows = await get().db.select().from(authThrottle).where(like(authThrottle.key, "aaaa%"));
      expect(rows).toHaveLength(0);
    });

    test("old sign-in attempts are pruned for every key; recent ones stay", async () => {
      const { db } = get();
      const now = new Date();
      await db.insert(authThrottle).values([
        { kind: "password", key: "prune-old-1@example.test", at: new Date(now.getTime() - THROTTLE_WINDOW_MS - 60_000) },
        { kind: "code_send", key: "prune-old-2", at: new Date(now.getTime() - 86_400_000) },
        { kind: "password", key: "prune-new@example.test", at: new Date(now.getTime() - 60_000) },
      ]);
      await pruneThrottle(db, now);
      const keys = (await db.select().from(authThrottle).where(like(authThrottle.key, "prune-%"))).map((r) => r.key);
      expect(keys).toEqual(["prune-new@example.test"]);
    });

    test("a reset request answers without waiting for the mail server, so its timing does not reveal the account", async () => {
      const email = "slow-mail@example.test";
      await makeUser(email);
      let release!: () => void;
      const sent: string[] = [];
      const slow = { send: (m: { to: string[] }) => new Promise<void>((r) => (release = () => { sent.push(...m.to); r(); })) };
      const a = createAuth({ db: get().db, emailSender: slow as never, security: DEFAULT_SETTINGS.security });
      const answer = a.api.requestPasswordReset({ body: { email, redirectTo: "/reset-password" } });
      const raced = await Promise.race([answer.then(() => "answered"), new Promise((r) => setTimeout(() => r("waiting"), 2_000))]);
      expect(raced).toBe("answered");
      release();
      await vi.waitFor(() => expect(sent).toEqual([email]));
    });

    test("a locked (inactive) user unlocks themselves with a reset link and an emailed code", async () => {
      const email = "locked@example.test";
      const id = await makeUser(email);
      const { db } = get();
      const old = new Date(Date.now() - 100 * DAY);
      await db.update(users).set({ lastSignInAt: old, createdAt: old }).where(eq(users.id, id));
      await db.update(accounts).set({ createdAt: old, updatedAt: old }).where(eq(accounts.userId, id));

      const locked = await authError(passwordStep(auth, email, PASSWORD));
      expect(locked).toEqual({ code: "ACCOUNT_LOCKED", status: 403 });
      expect(await db.select().from(sessions).where(eq(sessions.userId, id))).toHaveLength(0);
      const [afterLock] = await db.select().from(users).where(eq(users.id, id));
      expect(afterLock.lockedAt).not.toBeNull();
      expect(afterLock.lockReason).toBe("inactivity");
      const lockAudit = await db.select().from(auditLog).where(and(eq(auditLog.entityId, id), eq(auditLog.action, "user.lock")));
      expect(lockAudit).toHaveLength(1);
      expect(lockAudit[0].actorUserId).toBeNull();

      // Self-service unlock: the UI requests the reset link for the same email.
      await auth.api.requestPasswordReset({ body: { email, redirectTo: "/reset-password" } });
      const resetMail = lastMailTo(email)!;
      const m = resetMail.text.match(/\/api\/auth\/reset-password\/([A-Za-z0-9_-]+)\?callbackURL=/);
      expect(m).not.toBeNull();
      await auth.api.resetPassword({ body: { newPassword: "a brand new password", token: m![1] } });

      const [afterReset] = await db.select().from(users).where(eq(users.id, id));
      expect(afterReset.lockedAt).toBeNull();
      expect(afterReset.lockReason).toBeNull();
      expect(afterReset.lastSignInAt!.getTime()).toBe(old.getTime());
      const unlockAudit = await db.select().from(auditLog).where(and(eq(auditLog.entityId, id), eq(auditLog.action, "user.unlock")));
      expect(unlockAudit).toHaveLength(1);

      expect((await authError(passwordStep(auth, email, PASSWORD))).code).toBe("INVALID_EMAIL_OR_PASSWORD");
      const before = Date.now();
      const jar = await fullSignIn(email, "a brand new password");
      expect(await getActor(jar.headers())).toMatchObject({ userId: id });
      const [done] = await db.select().from(users).where(eq(users.id, id));
      expect(done.lastSignInAt!.getTime()).toBeGreaterThanOrEqual(before - 1000);
    });

    test("an explicitly locked user is refused even with recent activity", async () => {
      const email = "locked2@example.test";
      const id = await makeUser(email);
      await get().db.update(users).set({ lockedAt: new Date(), lockReason: "forced" }).where(eq(users.id, id));
      expect((await authError(passwordStep(auth, email, PASSWORD))).code).toBe("ACCOUNT_LOCKED");
    });
  });

  describe("sign-in page", () => {
    test("shows the inactivity notice beside Forgot password?, following the setting", async () => {
      const paragraph = (html: string) => html.match(/<p[^>]*>(?:(?!<\/p>).)*Forgot password\?(?:(?!<\/p>).)*<\/p>/)?.[0] ?? "";
      const html90 = renderToStaticMarkup(await SignInPage());
      expect(paragraph(html90)).toContain("Accounts not signed in within the past 3 months require a password reset.");

      const admin: Actor = { ...coordinator, role: "admin" };
      await get().db.transaction((tx) => updateSettings(admin, tx, { inactivityLockDays: 180 }));
      const html180 = renderToStaticMarkup(await SignInPage());
      expect(paragraph(html180)).toContain("Accounts not signed in within the past 6 months require a password reset.");
      await get().db.transaction((tx) => updateSettings(admin, tx, { inactivityLockDays: 90 }));
    });
  });

  describe("rate limit", () => {
    test("the sixth failed sign-in for one email from one IP is refused with the real wait; other accounts on that IP sign in", async () => {
      const email = "rl1@example.test";
      await makeUser(email);
      for (let i = 1; i <= 5; i++) {
        const res = await http("/sign-in/email", { email, password: "wrong password 123" }, "10.0.0.1");
        expect(res.status, `attempt ${i}`).toBe(401);
      }
      const sixth = await http("/sign-in/email", { email, password: PASSWORD }, "10.0.0.1");
      expect(sixth.status).toBe(429);
      expect(await sixth.json()).toMatchObject({ code: "TOO_MANY_SIGN_IN_ATTEMPTS", message: "Too many failed sign-in attempts. Wait 15 minutes and try again." });
      expect(sixth.headers.getSetCookie().join("")).not.toMatch(/session_token|two_factor/);

      const other = "rl1-colleague@example.test";
      await makeUser(other);
      expect((await http("/sign-in/email", { email: other, password: PASSWORD }, "10.0.0.1")).status).toBe(200);
      // The same account from another address still has its own five tries.
      expect((await http("/sign-in/email", { email, password: "wrong password 123" }, "10.0.0.2")).status).toBe(401);
    });

    test("the wait shown is the time until the oldest counted failure leaves the window", async () => {
      const email = "rl-wait@example.test";
      await makeUser(email);
      for (let i = 1; i <= 5; i++) await http("/sign-in/email", { email, password: "wrong password 123" }, "10.0.5.1");
      await get()
        .db.update(authThrottle)
        .set({ at: new Date(Date.now() - 14 * 60_000 - 30_000) })
        .where(and(eq(authThrottle.kind, "password_ip"), eq(authThrottle.key, `${email}|10.0.5.1`)));
      const res = await http("/sign-in/email", { email, password: PASSWORD }, "10.0.5.1");
      expect(res.status).toBe(429);
      expect(((await res.json()) as { message: string }).message).toMatch(/^Too many failed sign-in attempts\. Wait (29|30) seconds and try again\.$/);
    });

    test("across addresses one email gets ten tries in 15 minutes", async () => {
      const email = "rl-spread@example.test";
      await makeUser(email);
      for (let i = 1; i <= 10; i++) {
        expect((await http("/sign-in/email", { email, password: "wrong password 123" }, `10.0.6.${i}`)).status, `attempt ${i}`).toBe(401);
      }
      expect((await http("/sign-in/email", { email, password: PASSWORD }, "10.0.6.11")).status).toBe(429);
    });

    test("an attempt refused by the account-wide limit does not use up that address's own allowance", async () => {
      const email = "rl-order@example.test";
      await makeUser(email);
      for (let i = 1; i <= 10; i++) expect((await http("/sign-in/email", { email, password: "wrong password 123" }, `10.0.10.${i}`)).status).toBe(401);
      for (let i = 0; i < 3; i++) expect((await http("/sign-in/email", { email, password: PASSWORD }, "10.0.10.99")).status).toBe(429);
      const counted = await get().db.select().from(authThrottle).where(and(eq(authThrottle.kind, "password_ip"), eq(authThrottle.key, `${email}|10.0.10.99`)));
      expect(counted).toHaveLength(0);
    });

    test("many accounts sign in from one office IP in quick succession, with the per-IP ceiling on", async () => {
      const limited = createAuth({ db: get().db, emailSender: mail, security: DEFAULT_SETTINGS.security, ipRateLimit: true });
      const emails = Array.from({ length: 8 }, (_, i) => `office${i}@example.test`);
      for (const e of emails) await makeUser(e);
      for (const e of emails) {
        const res = await http("/sign-in/email", { email: e, password: PASSWORD }, "10.0.7.1", limited);
        expect(res.status, e).toBe(200);
        expect(((await res.json()) as { twoFactorRedirect?: boolean }).twoFactorRedirect).toBe(true);
      }
    });

    test("the per-IP ceiling refuses the 61st sign-in request in a minute and says how long to wait", async () => {
      const limited = createAuth({ db: get().db, emailSender: mail, security: DEFAULT_SETTINGS.security, ipRateLimit: true });
      for (let i = 1; i <= 60; i++) {
        expect((await http("/sign-in/email", { email: `flood${i}@example.test`, password: "wrong password 123" }, "10.0.8.1", limited)).status, `request ${i}`).toBe(401);
      }
      const res = await http("/sign-in/email", { email: "flood61@example.test", password: "wrong password 123" }, "10.0.8.1", limited);
      expect(res.status).toBe(429);
      expect(Number(res.headers.get("x-retry-after"))).toBeGreaterThan(0);
      // Another address is not affected.
      expect((await http("/sign-in/email", { email: "flood62@example.test", password: "wrong password 123" }, "10.0.8.2", limited)).status).toBe(401);
    });

    test("failures older than 15 minutes no longer count", async () => {
      const email = "rl2@example.test";
      await makeUser(email);
      for (let i = 1; i <= 5; i++) {
        await http("/sign-in/email", { email, password: "wrong password 123" }, "10.1.0.1");
      }
      expect((await http("/sign-in/email", { email, password: PASSWORD }, "10.1.0.1")).status).toBe(429);
      await backdateThrottle("password", email);
      const ok = await http("/sign-in/email", { email, password: PASSWORD }, "10.1.0.1");
      expect(ok.status).toBe(200);
      expect(((await ok.json()) as { twoFactorRedirect?: boolean }).twoFactorRedirect).toBe(true);
    });

    test("unknown emails are limited the same way", async () => {
      const email = "nobody@example.test";
      for (let i = 1; i <= 5; i++) {
        expect((await http("/sign-in/email", { email, password: "wrong password 123" }, "10.2.0.1")).status).toBe(401);
      }
      expect((await http("/sign-in/email", { email, password: "wrong password 123" }, "10.2.0.1")).status).toBe(429);
    });

    test("parallel wrong passwords cannot get past ten password checks for one email", async () => {
      const email = "rl-parallel@example.test";
      await makeUser(email);
      const results = await Promise.all(
        Array.from({ length: 20 }, (_, i) =>
          http("/sign-in/email", { email, password: "wrong password 123" }, `10.3.0.${i + 1}`),
        ),
      );
      const statuses = results.map((r) => r.status);
      expect(statuses.filter((s) => s === 401)).toHaveLength(10);
      expect(statuses.filter((s) => s === 429)).toHaveLength(10);
      expect((await http("/sign-in/email", { email, password: PASSWORD }, "10.3.0.99")).status).toBe(429);
    });

    test("a sixth code request within 15 minutes for one user is refused", async () => {
      const email = "code-send-cap@example.test";
      await makeUser(email);
      const { jar } = await passwordStep(auth, email, PASSWORD);
      for (let i = 0; i < 5; i++) await auth.api.sendTwoFactorOTP({ headers: jar.headers(), body: {} });
      expect(await authError(sendSignInCode(jar.headers()))).toEqual({ code: "TOO_MANY_CODE_REQUESTS", status: 429 });
      expect(mailTo(email).filter((m) => m.subject === "Your sign-in code")).toHaveLength(5);
      // A fresh sign-in does not reset the count.
      const again = await passwordStep(auth, email, PASSWORD);
      expect((await authError(auth.api.sendTwoFactorOTP({ headers: again.jar.headers(), body: {} }))).code).toBe(
        "TOO_MANY_CODE_REQUESTS",
      );
    });

    test("after ten code checks in 15 minutes the user is refused across codes and sign-ins", async () => {
      const email = "code-verify-cap@example.test";
      const id = await makeUser(email);
      const { jar } = await passwordStep(auth, email, PASSWORD);
      for (let round = 0; round < 2; round++) {
        await auth.api.sendTwoFactorOTP({ headers: jar.headers(), body: {} });
        const wrong = wrongFor(codeFrom(lastMailTo(email)));
        for (let i = 0; i < 5; i++) expect((await authError(verify(auth, jar, wrong))).code).toBe("INVALID_CODE");
      }
      await auth.api.sendTwoFactorOTP({ headers: jar.headers(), body: {} });
      expect(await authError(verify(auth, jar, codeFrom(lastMailTo(email))))).toEqual({
        code: "TOO_MANY_CODE_ATTEMPTS",
        status: 429,
      });

      const second = await passwordStep(auth, email, PASSWORD);
      await auth.api.sendTwoFactorOTP({ headers: second.jar.headers(), body: {} });
      const code = codeFrom(lastMailTo(email));
      expect((await authError(verify(auth, second.jar, code))).code).toBe("TOO_MANY_CODE_ATTEMPTS");
      expect(await getActor(second.jar.headers())).toBeNull();

      await backdateThrottle("code_verify", id);
      await verify(auth, second.jar, code);
      expect(await getActor(second.jar.headers())).toMatchObject({ userId: id });
    });
  });

  describe("session lifetime", () => {
    const H12 = 12 * 3600_000;

    async function codeStep(email: string, trustDevice: boolean) {
      const { jar } = await passwordStep(auth, email, PASSWORD);
      await auth.api.sendTwoFactorOTP({ headers: jar.headers(), body: {} });
      const { headers } = await auth.api.verifyTwoFactorOTP({
        body: { code: codeFrom(lastMailTo(email)), trustDevice },
        headers: jar.headers(),
        returnHeaders: true,
      });
      jar.apply(headers);
      return { jar, headers };
    }

    async function sessionExpiry(userId: string): Promise<number> {
      const rows = await get().db.select().from(sessions).where(eq(sessions.userId, userId));
      return rows.at(-1)!.expiresAt.getTime() - Date.now();
    }

    test("an untrusted sign-in gets a browser-session cookie and a 12-hour session", async () => {
      const email = "untrusted@example.test";
      const id = await makeUser(email);
      const { jar, headers } = await codeStep(email, false);
      const cookie = lastSetCookie(headers, "session_token");
      expect(cookie).not.toMatch(/max-age|expires/i);
      expect(Math.abs((await sessionExpiry(id)) - H12)).toBeLessThan(60_000);
      expect(await getActor(jar.headers())).toMatchObject({ userId: id });
    });

    test("a trusted sign-in keeps a 30-day session, also when the trusted device signs in again", async () => {
      const email = "trusted@example.test";
      const id = await makeUser(email);
      const { jar, headers } = await codeStep(email, true);
      expect(lastSetCookie(headers, "session_token")).toMatch(new RegExp(`max-age=${30 * 86_400}(;|$)`, "i"));
      expect(Math.abs((await sessionExpiry(id)) - 30 * DAY)).toBeLessThan(60_000);

      jar.drop("session_token");
      const { headers: again } = await auth.api.signInEmail({
        body: { email, password: PASSWORD },
        headers: jar.headers(),
        returnHeaders: true,
      });
      expect(lastSetCookie(again, "session_token")).toMatch(new RegExp(`max-age=${30 * 86_400}(;|$)`, "i"));
      expect(Math.abs((await sessionExpiry(id)) - 30 * DAY)).toBeLessThan(60_000);
    });
  });

  describe("API bearer tokens", () => {
    test("no session token exists before the code is accepted, so nothing a bearer can send reaches a protected route", async () => {
      const id = await makeUser("bearer-2fa@example.test");
      const { db } = get();
      const { jar, response } = await passwordStep(auth, "bearer-2fa@example.test", PASSWORD);
      expect(response.twoFactorRedirect).toBe(true);
      expect(await db.select().from(sessions).where(eq(sessions.userId, id))).toHaveLength(0);
      // Every value the browser holds now (the two-factor challenge) is refused as a bearer token.
      const held = jar.headers().get("cookie")!.split("; ").map((c) => decodeURIComponent(c.slice(c.indexOf("=") + 1)));
      expect(held.length).toBeGreaterThan(0);
      for (const value of held) {
        const res = await listJobsRoute(new Request("http://localhost/api/v1/jobs", { headers: { authorization: `Bearer ${value}` } }), { params: Promise.resolve({}) });
        expect(res.status).toBe(401);
      }
      await auth.api.sendTwoFactorOTP({ headers: jar.headers(), body: {} });
      await verify(auth, jar, codeFrom(lastMailTo("bearer-2fa@example.test")));
      const [s] = await db.select().from(sessions).where(eq(sessions.userId, id));
      const ok = await listJobsRoute(new Request("http://localhost/api/v1/jobs", { headers: { authorization: `Bearer ${s.token}` } }), { params: Promise.resolve({}) });
      expect(ok.status).toBe(200);
    });
  });
});
