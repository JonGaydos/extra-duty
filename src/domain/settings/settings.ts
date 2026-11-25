import { and, eq, isNotNull } from "drizzle-orm";
import { z } from "zod";
import type { Tx } from "@/db/client";
import { positionTypes, settings, vendors } from "@/db/schema";
import { outsideRange, rateDollars, rateRangeMessage } from "../jobs/rate";
import { recomputeReleaseDates } from "../release/release";
import type { Actor } from "../actor";
import { recordAudit } from "../audit/audit";
import { assertCan } from "../auth/policy";
import { ForbiddenError, ValidationError } from "../errors";
import { encryptSecret } from "@/lib/crypto/secrets";
import { agencyChannelsProblem, type AgencyChannels } from "../notifications/catalog";
import { cleanChangedPhone } from "../phone";
import { DEFAULT_POSITION_TYPE_NAME, DEFAULT_SETTINGS } from "./defaults";

const int = z.number().int();

/** Agency Email and Push switches per notification type and recipient group; anything missing is on. */
const notificationChannelsSchema = z
  .record(z.string(), z.record(z.string(), z.object({ email: z.boolean().optional(), push: z.boolean().optional() }).strict()))
  .superRefine((v, ctx) => {
    const problem = agencyChannelsProblem(v as AgencyChannels);
    if (problem) ctx.addIssue({ code: "custom", message: problem });
  });
const hours = int.min(0).max(24 * 365);

export const agencySettingsSchema = z.object({
  releaseDayOfMonth: int.min(1).max(31),
  releaseTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  weekStartsOn: int.min(0).max(6),
  rollingCapWindowHours: int.min(1).max(24 * 31),
  signupWarningText: z.string(),
  signupWarningVersion: int.min(1),
  defaultPositionTypeId: z.string().nullable(),
  shortShiftWindowHours: hours,
  backupOfferMode: z.enum(["sequential", "all_backups", "everyone"]),
  backupWindowMinutes: int.min(1).max(24 * 60),
  backupFirstComeHours: hours,
  minimumBillableMinutes: int.min(0).max(24 * 60),
  lateVendorCancelHours: hours,
  lateCancelPayBasis: z.enum(["minimum", "scheduled"]),
  hourRoundingMinutes: int.min(1).max(60),
  agencyDefaultRateCents: int.min(0),
  /** The agency-wide hourly rate range; null means no limit on that side. */
  rateMinCents: int.min(1).nullable(),
  rateMaxCents: int.min(1).nullable(),
  invoiceReviewMode: z.enum(["immediate", "changed_hours_only", "all"]),
  invoiceNumberPrefix: z.string().max(20),
  /** When approved invoices go to vendors: at once, or batched per vendor on a schedule (vendors may override). */
  invoiceSendSchedule: z.enum(["immediate", "weekly", "every_2_weeks", "monthly"]),
  invoiceSendDayOfWeek: int.min(0).max(6),
  /** Every-two-weeks phase: the first send weekday on or after this date is a send day. */
  invoiceSendStartDate: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/),
  invoiceSendDayOfMonth: int.min(1).max(31),
  /** Batched invoices of a detail wait until every assigned deputy has billed (a detail may override). */
  waitForAllDeputies: z.boolean(),
  billingReplyToEmail: z.union([z.literal(""), z.email()]),
  email: z.object({
    provider: z.enum(["smtp", "postmark", "ses", "sendgrid", "mailgun"]),
    from: z.string(),
    smtp: z.object({
      host: z.string(),
      port: int.min(1).max(65535),
      secure: z.boolean(),
      user: z.string(),
      passwordEnc: z.string(),
    }),
    apiKeyEnc: z.string(),
    region: z.string(),
  }),
  unbilledReminderFrequency: z.enum(["daily", "every_other_day", "weekly"]),
  unbilledGraceHours: hours,
  billingLockEnabled: z.boolean(),
  responseDays: z.object({
    vendor: int.min(0).max(365),
    deputy: int.min(0).max(365),
    coordinator: int.min(0).max(365),
  }),
  paymentAckLockMode: z.enum(["off", "vendor_reported", "all_invoices"]),
  vendorReminderEnabled: z.boolean(),
  trainingNightlyReset: z.boolean(),
  inactivityLockDays: int.min(1).max(3650),
  accessReviewMonthDay: z.string().regex(/^(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/),
  accessReviewEveryMonths: int.min(1).max(120),
  opsPlanReviewerUserIds: z.array(z.string()),
  notificationChannels: notificationChannelsSchema,
  opsPlanDefaultDueHours: hours,
  capHoursMode: z.enum(["details_only", "details_plus_schedule"]),
  vendorMinNoticeHours: hours,
  vendorEditLockHours: hours,
  vendorEditsAfterSignup: z.enum(["none", "add_positions"]),
  vendorCancelUntilHours: hours,
  vendorCanSetRate: z.boolean(),
  vendorSeesAssignedNames: z.boolean(),
  personnelCanMessageAll: z.boolean(),
  mapTileUrl: z.string().min(1),
  mapAttribution: z.string(),
  mapDefaultCenter: z.object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180), zoom: int.min(1).max(19) }),
  agency: z.object({
    name: z.string().min(1),
    sheriffName: z.string(),
    address: z.string(),
    phone: z.string(),
    email: z.string(),
    website: z.string(),
    logoFileId: z.string().nullable(),
    /** The stored logo PNG's size, so layouts pick the square or the wide slot without opening it. Null for a logo saved before sizes were kept. */
    logoWidth: int.min(1).nullable(),
    logoHeight: int.min(1).nullable(),
    /** Whether the logo has any transparent pixel: night mode puts the light plate only behind logos without. Null when not measured yet. */
    logoTransparent: z.boolean().nullable(),
  }),
  security: z.object({
    /** Always on (global rule); kept so stored settings parse, never offered as a switch. */
    twoFactorRequired: z.literal(true),
    emailCodeMinutes: int.min(1).max(24 * 60),
    emailCodeAttempts: int.min(1).max(20),
    trustedDeviceDays: int.min(0).max(365),
    passwordMinLength: int.min(8).max(128),
  }),
});

export type AgencySettings = z.infer<typeof agencySettingsSchema>;
export type SettingKey = keyof AgencySettings;

/** Keys only admins may change. Every other key is open to coordinators and admins. */
export const ADMIN_SETTING_KEYS = ["email", "security"] as const satisfies readonly SettingKey[];

type DeepPartial<T> = T extends readonly unknown[] ? T : T extends object ? { [K in keyof T]?: DeepPartial<T[K]> } : T;

/** Plaintext `password` and `apiKey` are accepted on input and stored encrypted. */
export type SettingsPatch = DeepPartial<Omit<AgencySettings, "email">> & {
  email?: DeepPartial<AgencySettings["email"]> & {
    apiKey?: string;
    smtp?: DeepPartial<AgencySettings["email"]["smtp"]> & { password?: string };
  };
};

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function deepMerge(base: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    const cur = out[k];
    out[k] = isPlainObject(v) && isPlainObject(cur) ? deepMerge(cur, v) : v;
  }
  return out;
}

async function loadRow(tx: Tx) {
  const [row] = await tx.select().from(settings).limit(1);
  return row;
}

async function resolveDefaultPositionTypeId(tx: Tx): Promise<string | null> {
  const [pt] = await tx
    .select({ id: positionTypes.id })
    .from(positionTypes)
    .where(eq(positionTypes.name, DEFAULT_POSITION_TYPE_NAME))
    .limit(1);
  return pt?.id ?? null;
}

async function current(tx: Tx): Promise<{ rowId: string | null; value: AgencySettings }> {
  const row = await loadRow(tx);
  const stored = isPlainObject(row?.value) ? row.value : {};
  const merged = deepMerge(DEFAULT_SETTINGS as unknown as Record<string, unknown>, stored);
  if (!stored.defaultPositionTypeId) merged.defaultPositionTypeId = await resolveDefaultPositionTypeId(tx);
  return { rowId: row?.id ?? null, value: agencySettingsSchema.parse(merged) };
}

/** Defaults when no row exists. Secrets are returned only in encrypted form. */
export async function getSettings(tx: Tx): Promise<AgencySettings> {
  return (await current(tx)).value;
}

/** Secrets never reach the audit log; `prev` marks the ones this save changed, so the log still shows it. */
function maskSecrets(s: AgencySettings, prev?: AgencySettings): AgencySettings {
  const mask = (v: string, was?: string) => (v ? (was !== undefined && was !== v ? "[encrypted, changed]" : "[encrypted]") : "");
  return {
    ...s,
    email: { ...s.email, apiKeyEnc: mask(s.email.apiKeyEnc, prev?.email.apiKeyEnc), smtp: { ...s.email.smtp, passwordEnc: mask(s.email.smtp.passwordEnc, prev?.email.smtp.passwordEnc) } },
  };
}

export type RateRangeProblem = { key: "rateMinCents" | "rateMaxCents" | "agencyDefaultRateCents"; message: string };

/**
 * Why a rate range (or agency default) cannot be saved: the minimum is above the maximum, or the agency default or
 * a vendor's default rate falls outside it. Checked only when one of those settings changes, so old data never
 * blocks an unrelated save.
 */
export async function rateRangeProblems(tx: Tx, before: AgencySettings, after: AgencySettings): Promise<RateRangeProblem[]> {
  if (before.rateMinCents === after.rateMinCents && before.rateMaxCents === after.rateMaxCents && before.agencyDefaultRateCents === after.agencyDefaultRateCents) return [];
  const r = { rateMinCents: after.rateMinCents, rateMaxCents: after.rateMaxCents };
  if (r.rateMinCents !== null && r.rateMaxCents !== null && r.rateMinCents > r.rateMaxCents) {
    return [{ key: "rateMaxCents", message: "The maximum must be at least the minimum." }];
  }
  const out: RateRangeProblem[] = [];
  // Zero means the agency has no default rate of its own.
  if (after.agencyDefaultRateCents > 0 && outsideRange(after.agencyDefaultRateCents, r)) {
    out.push({ key: "agencyDefaultRateCents", message: `The agency default rate of ${rateDollars(after.agencyDefaultRateCents)} is outside the range. ${rateRangeMessage(r)}.` });
  }
  const outside = (await tx.select({ name: vendors.name, rate: vendors.defaultRateCents }).from(vendors).where(and(isNotNull(vendors.defaultRateCents), eq(vendors.active, true)))).filter(
    (v) => v.rate !== null && outsideRange(v.rate, r),
  );
  if (outside.length) {
    const names = outside.slice(0, 5).map((v) => `${v.name} (${rateDollars(v.rate!)})`).join(", ");
    const more = outside.length > 5 ? ` and ${outside.length - 5} more` : "";
    out.push({
      key: r.rateMinCents !== null && outside.some((v) => v.rate! < r.rateMinCents!) ? "rateMinCents" : "rateMaxCents",
      message: `These vendor default rates are outside the range: ${names}${more}. Change them first.`,
    });
  }
  return out;
}

/**
 * The one settings write with no person behind it: a logo saved before its size or transparency was kept, measured
 * on first use. Changes only the agency logo fields and audits the change as the system.
 */
export async function setLogoBySystem(tx: Tx, logo: { logoFileId: string; logoWidth: number; logoHeight: number; logoTransparent: boolean }): Promise<void> {
  const { rowId, value: before } = await current(tx);
  const after = agencySettingsSchema.parse({ ...before, agency: { ...before.agency, ...logo } });
  let id = rowId;
  if (id) await tx.update(settings).set({ value: after }).where(eq(settings.id, id));
  else id = (await tx.insert(settings).values({ value: after }).returning({ id: settings.id }))[0].id;
  await recordAudit(tx, { actor: "system", action: "settings.logo_upgrade", entityType: "settings", entityId: id, before: { agency: before.agency }, after: { agency: after.agency } });
}

/**
 * Changes the agency's notification switches: only the switches in `patch` change. Audited on its own, with the
 * switches before and after. Locked types cannot be turned off.
 */
export async function saveNotificationChannels(actor: Actor, tx: Tx, patch: AgencyChannels): Promise<AgencyChannels> {
  assertCan(actor, "settings.notifications");
  if (!isPlainObject(patch)) throw new ValidationError("Send the notification switches as an object.");
  const { rowId, value: before } = await current(tx);
  const merged = deepMerge(before.notificationChannels as Record<string, unknown>, patch as Record<string, unknown>);
  const parsed = agencySettingsSchema.safeParse({ ...before, notificationChannels: merged });
  if (!parsed.success) throw new ValidationError(parsed.error.issues.map((i) => i.message).join("; "));
  const after = parsed.data;
  let id = rowId;
  if (id) await tx.update(settings).set({ value: after }).where(eq(settings.id, id));
  else id = (await tx.insert(settings).values({ value: after }).returning({ id: settings.id }))[0].id;
  await recordAudit(tx, {
    actor,
    action: "settings.notifications",
    entityType: "settings",
    entityId: id,
    before: { notificationChannels: before.notificationChannels },
    after: { notificationChannels: after.notificationChannels },
  });
  return after.notificationChannels as AgencyChannels;
}

export async function updateSettings(actor: Actor, tx: Tx, patch: SettingsPatch): Promise<AgencySettings> {
  return (await saveSettings(actor, tx, patch)).settings;
}

/**
 * updateSettings with its side effects reported: when the release day or time changes, details that have not
 * opened yet get new release dates and `releaseDatesMoved` says how many (null when release did not change).
 */
export async function saveSettings(actor: Actor, tx: Tx, patch: SettingsPatch): Promise<{ settings: AgencySettings; releaseDatesMoved: number | null }> {
  if (actor.role !== "admin" && actor.role !== "coordinator") {
    throw new ForbiddenError("Only coordinators and admins can change settings.");
  }
  const keys = Object.entries(patch)
    .filter(([, v]) => v !== undefined)
    .map(([k]) => k);
  const known = new Set<string>(Object.keys(agencySettingsSchema.shape));
  const unknown = keys.filter((k) => !known.has(k));
  if (unknown.length) throw new ValidationError(`Unknown setting: ${unknown.join(", ")}.`);
  const adminOnly = keys.filter((k) => (ADMIN_SETTING_KEYS as readonly string[]).includes(k));
  if (actor.role !== "admin" && adminOnly.length) {
    throw new ForbiddenError(`Only admins can change: ${adminOnly.join(", ")}.`);
  }

  const { rowId, value: before } = await current(tx);

  const toMerge: Record<string, unknown> = { ...patch };
  if (patch.agency?.phone !== undefined) toMerge.agency = { ...patch.agency, phone: cleanChangedPhone(patch.agency.phone, before.agency.phone) ?? "" };
  if (patch.email) {
    const { apiKey, smtp, ...restEmail } = patch.email;
    const email: Record<string, unknown> = { ...restEmail };
    if (apiKey !== undefined) email.apiKeyEnc = apiKey ? encryptSecret(apiKey) : "";
    if (smtp) {
      const { password, ...restSmtp } = smtp;
      const smtpOut: Record<string, unknown> = { ...restSmtp };
      if (password !== undefined) smtpOut.passwordEnc = password ? encryptSecret(password) : "";
      email.smtp = smtpOut;
    }
    toMerge.email = email;
  }

  const merged = deepMerge(before as unknown as Record<string, unknown>, toMerge);
  if (merged.signupWarningText !== before.signupWarningText) {
    merged.signupWarningVersion = before.signupWarningVersion + 1;
  } else {
    merged.signupWarningVersion = before.signupWarningVersion;
  }

  const parsed = agencySettingsSchema.safeParse(merged);
  if (!parsed.success) {
    throw new ValidationError(parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
  }
  const after = parsed.data;
  const rateProblems = await rateRangeProblems(tx, before, after);
  if (rateProblems.length) throw new ValidationError(rateProblems.map((p) => p.message).join(" "));

  let id = rowId;
  if (id) {
    await tx.update(settings).set({ value: after }).where(eq(settings.id, id));
  } else {
    const [row] = await tx.insert(settings).values({ value: after }).returning({ id: settings.id });
    id = row.id;
  }
  await recordAudit(tx, {
    actor,
    action: "settings.update",
    entityType: "settings",
    entityId: id,
    before: maskSecrets(before),
    after: maskSecrets(after, before),
  });
  let releaseDatesMoved: number | null = null;
  if (after.releaseDayOfMonth !== before.releaseDayOfMonth || after.releaseTime !== before.releaseTime) {
    releaseDatesMoved = await recomputeReleaseDates(tx, { releaseDayOfMonth: after.releaseDayOfMonth, releaseTime: after.releaseTime }, actor);
  }
  return { settings: after, releaseDatesMoved };
}
