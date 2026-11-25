import { boolean, index, integer, pgEnum, pgTable, text } from "drizzle-orm/pg-core";
import { pk, timestamps, tstz } from "./common";
import { users } from "./users";

/** Live data or the training copy. Every new session starts live. */
export const dataMode = pgEnum("data_mode", ["live", "training"]);
/** The role a coordinator or admin practices as in training mode. */
export const practiceRole = pgEnum("practice_role", ["deputy", "coordinator", "admin", "vendor"]);

export const sessions = pgTable(
  "sessions",
  {
    id: pk(),
    expiresAt: tstz("expires_at").notNull(),
    token: text("token").notNull().unique(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    mode: dataMode("mode").notNull().default("live"),
    practiceRole: practiceRole("practice_role"),
    ...timestamps,
  },
  (t) => [index("sessions_user_idx").on(t.userId)],
);

export const accounts = pgTable(
  "accounts",
  {
    id: pk(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: tstz("access_token_expires_at"),
    refreshTokenExpiresAt: tstz("refresh_token_expires_at"),
    scope: text("scope"),
    password: text("password"),
    ...timestamps,
  },
  (t) => [index("accounts_user_idx").on(t.userId)],
);

export const verifications = pgTable("verifications", {
  id: pk(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: tstz("expires_at").notNull(),
  ...timestamps,
});

export const twoFactors = pgTable("two_factors", {
  id: pk(),
  secret: text("secret").notNull(),
  backupCodes: text("backup_codes").notNull(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  verified: boolean("verified").notNull().default(true),
  failedVerificationCount: integer("failed_verification_count").notNull().default(0),
  lockedUntil: tstz("locked_until"),
  ...timestamps,
});

/** One-time account setup links. Only a SHA-256 hash of the token is stored. */
export const invites = pgTable(
  "invites",
  {
    id: pk(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    tokenHash: text("token_hash").notNull().unique(),
    expiresAt: tstz("expires_at").notNull(),
    usedAt: tstz("used_at"),
    createdBy: text("created_by").references(() => users.id),
    ...timestamps,
  },
  (t) => [index("invites_user_idx").on(t.userId)],
);

/**
 * Attempt log for the sign-in limits: password attempts by email, code sends
 * and code verifications by user. Rows older than the window are pruned per key.
 */
export const authThrottle = pgTable(
  "auth_throttle",
  {
    id: pk(),
    kind: text("kind").notNull(),
    key: text("key").notNull(),
    at: tstz("at").notNull().defaultNow(),
  },
  (t) => [index("auth_throttle_kind_key_at_idx").on(t.kind, t.key, t.at)],
);

/**
 * Keys for the REST API. Only a SHA-256 hash of the key is stored; the full key is shown once when made.
 * `prefix` is the first characters of the key, kept to tell keys apart. A key acts as the admin who made it.
 * Scopes: `read`, `write` (includes read) and `w9` (W-9 downloads). Revoked keys stay for the record.
 */
export const apiKeys = pgTable(
  "api_keys",
  {
    id: pk(),
    name: text("name").notNull(),
    hashedKey: text("hashed_key").notNull().unique(),
    prefix: text("prefix").notNull(),
    scopes: text("scopes").array().notNull(),
    createdBy: text("created_by")
      .notNull()
      .references(() => users.id),
    lastUsedAt: tstz("last_used_at"),
    expiresAt: tstz("expires_at"),
    revokedAt: tstz("revoked_at"),
    ...timestamps,
  },
  (t) => [index("api_keys_created_by_idx").on(t.createdBy)],
);
