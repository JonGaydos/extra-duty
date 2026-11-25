import { forbidden, redirect } from "next/navigation";
import type { Actor } from "@/domain/actor";
import { loadShell } from "@/ui/shell/load-shell";

export { coordinatorActor as managementActor } from "../../coordinate/_coordinator/session";

/** The signed-in admin. A coordinator (or anyone else signed in) gets 403, not a redirect. */
export async function systemActor(): Promise<Actor> {
  const shell = await loadShell();
  if (!shell) redirect("/sign-in");
  if (shell.actor.role !== "admin") forbidden();
  return shell.actor;
}
