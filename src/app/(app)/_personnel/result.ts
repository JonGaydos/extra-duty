import type { Tx } from "@/db/client";
import type { Actor } from "@/domain/actor";
import { DomainError, RuleViolation, UnauthenticatedError } from "@/domain/errors";
import { requestContext, runInRequest, withTx } from "@/ui/shell/request";

/** What a server action tells the screen: done (with an optional message or value) or why not. */
export type ActionResult =
  | { ok: true; message?: string; value?: string }
  | { ok: false; error: string; checks?: Array<{ check: string; message: string }>; fields?: Record<string, string> };

/**
 * Runs one service call in a transaction as the signed-in person (in training mode, the demo user, on the training
 * database). Domain errors become messages for the screen (a rule violation lists each failing rule); anything else
 * is a real failure and is rethrown.
 */
export function act(fn: (actor: Actor, tx: Tx) => Promise<ActionResult | void>): Promise<ActionResult> {
  return actOutsideTx((actor) => withTx((tx) => fn(actor, tx)));
}

/** Like `act` for a service that manages its own transactions (such as a calendar sync that fetches between them). */
export async function actOutsideTx(fn: (actor: Actor) => Promise<ActionResult | void>): Promise<ActionResult> {
  try {
    const ctx = await requestContext();
    if (!ctx) throw new UnauthenticatedError();
    // The context is fixed for the whole action: a mode change while it runs does not move it.
    return (await runInRequest(ctx, () => fn(ctx.actor))) ?? { ok: true };
  } catch (e) {
    if (e instanceof RuleViolation) {
      const failing = e.checks.filter((c) => !c.ok);
      return { ok: false, error: failing.map((c) => c.message).join(". ") || e.message, checks: failing.map((c) => ({ check: c.check, message: c.message })), ...(e.fields ? { fields: e.fields } : {}) };
    }
    if (e instanceof DomainError) return { ok: false, error: e.message };
    throw e;
  }
}
