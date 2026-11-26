import { AsyncLocalStorage } from "node:async_hooks";
import { headers } from "next/headers";
import { cache } from "react";
import { runInMode, runnerFor, type Tx } from "@/db/client";
import { getRequestContext } from "@/domain/auth/session";
import type { RequestContext } from "@/domain/training/mode";

// Kept on globalThis so every Next bundle in the process shares it (see db/client.ts).
const KEY = Symbol.for("extra-duty.action-context");
const globals = globalThis as Record<symbol, unknown>;
globals[KEY] ??= new AsyncLocalStorage<RequestContext | null>();
const actionContext = globals[KEY] as AsyncLocalStorage<RequestContext | null>;

/** Settled once per page render: the layout and the page share it. */
const resolveOnce = cache(async (): Promise<RequestContext | null> => getRequestContext(await headers()));

/**
 * This request's context (null when signed out), settled once at its start: a server action's comes from
 * runInRequest, a page's from the first call in the render. A mode change during the request does not affect it.
 */
export async function requestContext(): Promise<RequestContext | null> {
  const fromAction = actionContext.getStore();
  return fromAction !== undefined ? fromAction : resolveOnce();
}

/** Runs a server action's work with its context fixed, in its mode. */
export function runInRequest<T>(ctx: RequestContext | null, fn: () => Promise<T>): Promise<T> {
  return actionContext.run(ctx, () => runInMode(ctx?.mode ?? "live", fn));
}

/**
 * The page and server-action wrapper: one transaction on this request's database (live, or training while the
 * session is in training mode). Pages and actions use this, never the database directly, so a service never
 * chooses a database itself.
 */
export async function withTx<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  const ctx = await requestContext();
  return (ctx?.run ?? runnerFor("live"))(fn);
}
