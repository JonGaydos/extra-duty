import { betterAuth, type BetterAuthPlugin } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { APIError, createAuthMiddleware, getIP, isAPIError } from "better-auth/api";
import { setSessionCookie } from "better-auth/cookies";
import { twoFactor } from "better-auth/plugins/two-factor";
import { eq } from "drizzle-orm";
import { uuidv7 } from "uuidv7";
import { liveDb as appDb, type Db } from "@/db/client";
import { accounts, sessions, twoFactors, users, verifications } from "@/db/schema";
import {
  MAX_EMAIL_LENGTH,
  SESSION_BLOCK_MESSAGES,
  checkSessionAllowed,
  clearAttempts,
  completePasswordReset,
  applySignInCodeRule,
  forgetAttempt,
  normalizeEmail,
  recordSignIn,
  signInCodeRequired,
  takeAttempt,
  type ThrottleKind,
} from "@/domain/auth/sign-in-policy";
import { waitText } from "@/domain/auth/wait-text";
import { getSettings, type AgencySettings } from "@/domain/settings/settings";
import { simpleEmail } from "./email/format";
import { ensureEmailSender } from "@/bootstrap/email";
import { getEmailSender } from "./email/sender";
import type { EmailSender } from "./email/types";


export type CreateAuthOptions = {
  db: Db;
  emailSender: EmailSender;
  security: AgencySettings["security"];
  /** Default: BETTER_AUTH_URL. */
  baseURL?: string;
  /** Default: BETTER_AUTH_SECRET. */
  secret?: string;
  /** Turns Better Auth's per-IP limits on or off; by default they run in production only. */
  ipRateLimit?: boolean;
};

const DAY_S = 86_400;
/** Better Auth two-factor plugin challenge cookie name. */
const TWO_FACTOR_COOKIE = "two_factor";

/** Endpoints that must not be reachable: self sign-up, profile edits, and every authenticator or backup-code route. */
const DISABLED_PATHS = [
  "/sign-up/email",
  "/update-user",
  "/change-email",
  "/delete-user",
  "/two-factor/enable",
  "/two-factor/disable",
  "/two-factor/get-totp-uri",
  "/two-factor/verify-totp",
  "/two-factor/generate-backup-codes",
  "/two-factor/verify-backup-code",
];


/** Sessions from a device the person did not mark as trusted. */
const UNTRUSTED_SESSION_S = 12 * 3600;

/** The refusal for each limit, with the real wait. */
function throttleError(kind: ThrottleKind, retryAfterMs: number): APIError {
  const wait = waitText(retryAfterMs);
  if (kind === "password" || kind === "password_ip") {
    return new APIError("TOO_MANY_REQUESTS", { code: "TOO_MANY_SIGN_IN_ATTEMPTS", message: `Too many failed sign-in attempts. Wait ${wait} and try again.` });
  }
  if (kind === "code_send") return new APIError("TOO_MANY_REQUESTS", { code: "TOO_MANY_CODE_REQUESTS", message: `Too many codes requested. Wait ${wait} and try again.` });
  return new APIError("TOO_MANY_REQUESTS", { code: "TOO_MANY_CODE_ATTEMPTS", message: `Too many incorrect codes. Wait ${wait} and sign in again.` });
}

/**
 * Per-IP ceilings, as abuse protection only: the real limits are per account (sign-in-policy.ts), so deputies who
 * share an office IP never lock each other out. They replace Better Auth's defaults of three per 10 seconds (sign-in,
 * two-factor) and three per minute (password reset requests).
 */
const IP_RATE_LIMITS = {
  "/sign-in/*": { window: 60, max: 60 },
  "/two-factor/*": { window: 60, max: 120 },
  "/request-password-reset": { window: 600, max: 20 },
} as const;

const THROTTLED_PATHS = new Set(["/sign-in/email", "/two-factor/send-otp", "/two-factor/verify-otp"]);

type HookCtx = Parameters<Parameters<typeof createAuthMiddleware>[0]>[0];

/** The user behind the pending two-factor challenge cookie, if it is still valid. */
async function pendingTwoFactorUser(ctx: HookCtx): Promise<string | null> {
  const cookie = ctx.context.createAuthCookie(TWO_FACTOR_COOKIE);
  const identifier = await ctx.getSignedCookie(cookie.name, ctx.context.secret);
  if (!identifier) return null;
  const v = await ctx.context.internalAdapter.findVerificationValue(identifier);
  return v && v.expiresAt > new Date() ? v.value : null;
}

function signInPolicy(db: Db, security: AgencySettings["security"]): BetterAuthPlugin {
  return {
    id: "extra-duty-sign-in-policy",
    hooks: {
      before: [
        {
          matcher: (ctx) => THROTTLED_PATHS.has(ctx.path ?? ""),
          handler: createAuthMiddleware(async (ctx) => {
            if (ctx.path === "/sign-in/email") {
              const email = normalizeEmail(ctx.body?.email);
              // No email: Better Auth rejects the request itself.
              if (!email) return;
              if (email.length > MAX_EMAIL_LENGTH) throw new APIError("BAD_REQUEST", { message: "Enter a valid email address." });
              // The account from this address first, then the account from every address.
              const ip = getIP(ctx.request ?? ctx.headers ?? new Headers(), ctx.context.options) ?? "unknown";
              const at = new Date();
              const perIp = await takeAttempt(db, "password_ip", `${email}|${ip}`, at);
              if (!perIp.ok) throw throttleError("password_ip", perIp.retryAfterMs);
              const wide = await takeAttempt(db, "password", email, at);
              if (!wide.ok) {
                // Refused account-wide: the attempt was never made, so it does not count against this address either.
                await forgetAttempt(db, "password_ip", `${email}|${ip}`, at);
                throw throttleError("password", wide.retryAfterMs);
              }
              await applySignInCodeRule(db, email, security.signInCodes);
              return;
            }
            const kind: ThrottleKind = ctx.path === "/two-factor/send-otp" ? "code_send" : "code_verify";
            const key = await pendingTwoFactorUser(ctx);
            // No challenge: Better Auth rejects the request itself.
            if (!key) return;
            const r = await takeAttempt(db, kind, key);
            if (!r.ok) throw throttleError(kind, r.retryAfterMs);
          }),
        },
      ],
      // Registered after the two-factor plugin, so a sign-in that still needs
      // the code has already had its session removed (newSession is null).
      after: [
        {
          matcher: (ctx) => ctx.path === "/sign-in/email" || ctx.path === "/two-factor/verify-otp",
          handler: createAuthMiddleware(async (ctx) => {
            if (ctx.path === "/sign-in/email") {
              const email = normalizeEmail(ctx.body?.email);
              // The password was right (a code is needed, or a trusted device signed in).
              if (email && !isAPIError(ctx.context.returned)) {
                await clearAttempts(db, "password", email);
                const ip = getIP(ctx.request ?? ctx.headers ?? new Headers(), ctx.context.options) ?? "unknown";
                await clearAttempts(db, "password_ip", `${email}|${ip}`);
              }
            }
            const created = ctx.context.newSession;
            if (!created) return;
            // A session here comes from a trusted device (sign-in), a code with "trust this device" ticked, or a
            // role that signs in without a code. Only the first two are trusted; anything else is a browser-session
            // cookie. A role without codes has no trusted devices, since no code step offers the choice.
            const [who] = await db.select({ role: users.role }).from(users).where(eq(users.id, created.user.id));
            const viaTrustedDevice = ctx.path === "/sign-in/email" && signInCodeRequired(who?.role ?? "", security.signInCodes);
            const trusted = security.trustedDeviceDays > 0 && (viaTrustedDevice || ctx.body?.trustDevice === true);
            const lifetimeS = trusted ? security.trustedDeviceDays * DAY_S : UNTRUSTED_SESSION_S;
            const expiresAt = new Date(Date.now() + lifetimeS * 1000);
            await db.update(sessions).set({ expiresAt }).where(eq(sessions.id, created.session.id));
            await setSessionCookie(
              ctx,
              { session: { ...created.session, expiresAt }, user: created.user },
              !trusted,
              trusted ? { maxAge: lifetimeS } : undefined,
            );
            if (ctx.path === "/two-factor/verify-otp") await clearAttempts(db, "code_verify", created.user.id);
            await recordSignIn(db, created.user.id);
          }),
        },
      ],
    },
  };
}

function codeEmail(to: string, code: string, minutes: number) {
  const msg = simpleEmail(to, "Your sign-in code", [
    `Your Signal 90 sign-in code is ${code}.`,
    `It expires in ${minutes} minutes. If you did not try to sign in, reset your password.`,
  ]);
  return { ...msg, auth: true as const };
}

function resetEmail(to: string, url: string) {
  const msg = simpleEmail(to, "Reset your password", [
    "Use this link to set a new Signal 90 password. It also unlocks an account locked for inactivity.",
    url,
    "The link expires in 1 hour. If you did not ask for this, ignore this email.",
  ]);
  return { ...msg, auth: true as const };
}

export function createAuth(o: CreateAuthOptions) {
  const { db, security } = o;
  return betterAuth({
    appName: "Signal 90",
    baseURL: o.baseURL ?? process.env.BETTER_AUTH_URL,
    secret: o.secret ?? process.env.BETTER_AUTH_SECRET,
    basePath: "/api/auth",
    database: drizzleAdapter(db, {
      provider: "pg",
      schema: { user: users, session: sessions, account: accounts, verification: verifications, twoFactor: twoFactors },
    }),
    advanced: { database: { generateId: () => uuidv7() } },
    disabledPaths: DISABLED_PATHS,
    rateLimit: { ...(o.ipRateLimit === undefined ? {} : { enabled: o.ipRateLimit }), customRules: { ...IP_RATE_LIMITS } },
    emailAndPassword: {
      enabled: true,
      disableSignUp: true,
      minPasswordLength: security.passwordMinLength,
      maxPasswordLength: 128,
      resetPasswordTokenExpiresIn: 3600,
      revokeSessionsOnPasswordReset: true,
      // Not awaited: a request for an address with an account must answer as fast as one without, so the
      // response time never reveals which addresses have accounts. A failed send is logged without the link.
      // better-auth expects a promise: it resolves at once, and a throw while starting the send still rejects it.
      sendResetPassword: ({ user, url }) =>
        new Promise<void>((resolve) => {
          o.emailSender.send(resetEmail(user.email, url)).catch((err: unknown) => {
            console.error("password reset email failed:", err instanceof Error ? err.message : String(err));
          });
          resolve();
        }),
      onPasswordReset: async ({ user }) => {
        await completePasswordReset(db, user.id);
      },
    },
    // Sessions do not roll forward, so an active person signs in (and
    // lastSignInAt moves) at least once per trusted-device period. The policy
    // plugin sets each session's real lifetime: 12 hours, or trustedDeviceDays
    // when the device is trusted.
    session: { expiresIn: UNTRUSTED_SESSION_S, disableSessionRefresh: true },
    databaseHooks: {
      session: {
        create: {
          before: async (session) => {
            const block = await checkSessionAllowed(db, session.userId);
            if (block) throw new APIError("FORBIDDEN", { code: block, message: SESSION_BLOCK_MESSAGES[block] });
          },
        },
      },
    },
    plugins: [
      twoFactor({
        totpOptions: { disable: true },
        trustDeviceMaxAge: security.trustedDeviceDays * DAY_S,
        // The challenge outlives one code, so a replacement code can still be requested.
        twoFactorCookieMaxAge: security.emailCodeMinutes * 60 * 2,
        otpOptions: {
          period: security.emailCodeMinutes,
          allowedAttempts: security.emailCodeAttempts,
          storeOTP: "hashed",
          // On staging the sender delivers it only to STAGING_EMAIL_ALLOWLIST; anything else goes to the outbox.
          sendOTP: async ({ user, otp }) => {
            await o.emailSender.send(codeEmail(user.email, otp, security.emailCodeMinutes));
          },
        },
      }),
      signInPolicy(db, security),
    ],
  });
}

export type Auth = ReturnType<typeof createAuth>;

const SETTINGS_RECHECK_MS = 30_000;
let app: { key: string; auth: Auth; checkedAt: number } | undefined;

/**
 * The app's auth instance, bound to DATABASE_URL, BETTER_AUTH_URL,
 * BETTER_AUTH_SECRET and APP_ENV. Rebuilt when the security settings change
 * (checked at most every 30 seconds).
 */
export async function getAuth(): Promise<Auth> {
  const now = Date.now();
  if (app && now - app.checkedAt < SETTINGS_RECHECK_MS) return app.auth;
  const { security } = await appDb.transaction((tx) => getSettings(tx));
  const key = JSON.stringify(security);
  if (app?.key === key) {
    app.checkedAt = now;
    return app.auth;
  }
  const auth = createAuth({
    db: appDb,
    emailSender: {
      send: (msg) => {
        // Instrumentation may not have run yet (first request racing startup).
        ensureEmailSender();
        return getEmailSender().send(msg);
      },
    },
    security,
  });
  app = { key, auth, checkedAt: now };
  return auth;
}

/** Sends the sign-in code for the pending two-factor challenge in `headers`. */
export async function sendSignInCode(headers: Headers, auth?: Auth): Promise<void> {
  const a = auth ?? (await getAuth());
  await a.api.sendTwoFactorOTP({ headers, body: {} });
}
