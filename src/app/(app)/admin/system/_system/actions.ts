"use server";

import { forbidden } from "next/navigation";
import type { Tx } from "@/db/client";
import { requestContext, runInRequest, withTx } from "@/ui/shell/request";
import type { Actor } from "@/domain/actor";
import { ValidationError } from "@/domain/errors";
import { agencySettingsSchema, getSettings, updateSettings } from "@/domain/settings/settings";
import { sendTestEmail } from "@/domain/settings/test-email";
import { act, actOutsideTx, type ActionResult } from "../../../_personnel/result";
import { GROUPS, type GroupValues } from "../../_admin/settings-groups";
import { saveGroup } from "../../_admin/settings-save";

/** Server actions for the System screens. Anyone but an admin gets HTTP 403 before anything runs. */

async function systemAct(fn: (actor: Actor, tx: Tx) => Promise<ActionResult | void>, inTx = true): Promise<ActionResult> {
  const ctx = await requestContext();
  if (!ctx) return { ok: false, error: "Your session ended. Sign in again." };
  if (ctx.actor.role !== "admin") forbidden();
  // Without a transaction, `tx` is never used (the service opens its own short ones).
  return runInRequest(ctx, () => (inTx ? act(fn) : actOutsideTx((a) => fn(a, undefined as never))));
}

/** Same shape as the Management settings save (slug, values), so the shared form can call it. */
export async function saveSecurityGroupAction(slug: string, values: GroupValues): Promise<ActionResult> {
  return systemAct((actor, tx) => {
    if (slug !== "security") throw new ValidationError("Unknown settings group.");
    return saveGroup(actor, tx, GROUPS.security, values);
  });
}

const PROVIDERS = agencySettingsSchema.shape.email.shape.provider.options;
export type EmailForm = {
  provider: string;
  from: string;
  host: string;
  port: string;
  secure: boolean;
  user: string;
  /** Blank keeps the saved secret. */
  password: string;
  clearPassword: boolean;
  apiKey: string;
  clearApiKey: boolean;
  region: string;
};

/** A write-only secret's patch: cleared, replaced when something was typed, or left out (kept) when empty. */
function secretPatch<K extends string>(key: K, clear: boolean, typed: string): Partial<Record<K, string>> {
  if (clear) return { [key]: "" } as Record<K, string>;
  return typed ? ({ [key]: typed } as Record<K, string>) : {};
}

/** Saves the email provider. Secrets are write-only: a blank field keeps what is saved; the screen never gets them back. */
export async function saveEmailAction(f: EmailForm): Promise<ActionResult> {
  return systemAct(async (actor, tx) => {
    const fields: Record<string, string> = {};
    if (!(PROVIDERS as readonly string[]).includes(f.provider)) fields.provider = "Choose a provider.";
    const port = Number(f.port);
    if (f.provider === "smtp") {
      if (!/^\d+$/.test(f.port.trim()) || port < 1 || port > 65535) fields.port = "Enter a port from 1 to 65535.";
      if (!f.host.trim()) fields.host = "Enter the email server's host name.";
    }
    if (f.from.trim() && !/^[^<>]*<[^<>\s@]+@[^<>\s@]+>\s*$|^[^\s@<>]+@[^\s@<>]+$/.test(f.from.trim())) fields.from = "Enter an address, such as Extra Duty <noreply@agency.gov>.";
    if (!f.from.trim()) fields.from = "Enter the address mail is sent from.";
    if (Object.keys(fields).length) return { ok: false, error: "Check the highlighted fields. Nothing was saved.", fields };
    const current = (await getSettings(tx)).email;
    await updateSettings(actor, tx, {
      email: {
        provider: f.provider as (typeof PROVIDERS)[number],
        from: f.from.trim(),
        region: f.region.trim(),
        smtp: {
          host: f.host.trim(),
          port: f.provider === "smtp" ? port : current.smtp.port,
          secure: f.secure,
          user: f.user.trim(),
          ...secretPatch("password", f.clearPassword, f.password),
        },
        ...secretPatch("apiKey", f.clearApiKey, f.apiKey.trim()),
      },
    });
    return { ok: true, message: "Email settings saved." };
  });
}

export async function sendTestEmailAction(): Promise<ActionResult> {
  return systemAct(async (actor) => {
    const to = await sendTestEmail(actor, withTx);
    return { ok: true, message: `Test email sent to ${to}.` };
  }, false);
}
