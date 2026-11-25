"use server";

import { forbidden } from "next/navigation";
import type { Actor } from "@/domain/actor";
import { requestContext, runInRequest, withTx } from "@/ui/shell/request";
import { createApiKey, revokeApiKey, type ApiKeyScope } from "@/domain/api-keys/api-keys";
import { DomainError, ValidationError } from "@/domain/errors";
import { agencyDateOnly } from "@/domain/time/agency-time";
import type { ActionResult } from "../../_personnel/result";

export type NewKeyForm = { name: string; access: "read" | "write"; w9: boolean; expiresOn: string };

async function adminAct(fn: (actor: Actor) => Promise<ActionResult>): Promise<ActionResult> {
  const ctx = await requestContext();
  if (!ctx) return { ok: false, error: "Your session ended. Sign in again." };
  if (ctx.actor.role !== "admin") forbidden();
  try {
    return await runInRequest(ctx, () => fn(ctx.actor));
  } catch (e) {
    if (e instanceof DomainError) return { ok: false, error: e.message };
    throw e;
  }
}

/** Makes a key and returns it once, as `value`. Only its hash is kept. An expiry date runs to the end of that agency day. */
export async function createApiKeyAction(f: NewKeyForm): Promise<ActionResult> {
  return adminAct(async (actor) => {
    const scopes: ApiKeyScope[] = [f.access === "write" ? "write" : "read"];
    if (f.w9) scopes.push("w9");
    let expiresAt: Date | undefined;
    if (f.expiresOn) {
      expiresAt = agencyDateOnly(f.expiresOn, "end") ?? undefined;
      if (!expiresAt) throw new ValidationError("Enter a valid expiry date.");
    }
    const { key } = await withTx((tx) => createApiKey(actor, tx, { name: f.name, scopes, expiresAt }));
    return { ok: true, message: "Key created. Copy it now.", value: key };
  });
}

export async function revokeApiKeyAction(id: string): Promise<ActionResult> {
  return adminAct(async (actor) => {
    const row = await withTx((tx) => revokeApiKey(actor, tx, id));
    return { ok: true, message: `${row.name} revoked. Requests with it now fail.` };
  });
}
