import { getAuth } from "@/lib/auth";
import type { Actor } from "../actor";
import { UnauthenticatedError } from "../errors";
import { contextForSession, type RequestContext } from "../training/mode";

/**
 * The request's context from its session cookie, or null with no session. A session exists only after the emailed
 * code (or a trusted device), so a pending second factor is null too. Deactivated and locked users are null even
 * with a live session.
 */
export async function getRequestContext(headers: Headers): Promise<RequestContext | null> {
  const auth = await getAuth();
  const session = await auth.api.getSession({ headers });
  if (!session) return null;
  return contextForSession({ id: session.session.id, userId: session.user.id });
}

/** Who the request acts as: the signed-in person, or in training mode the demo user they practice as. */
export async function getActor(headers: Headers): Promise<Actor | null> {
  return (await getRequestContext(headers))?.actor ?? null;
}

export async function requireActor(headers: Headers): Promise<Actor> {
  const actor = await getActor(headers);
  if (!actor) throw new UnauthenticatedError();
  return actor;
}
