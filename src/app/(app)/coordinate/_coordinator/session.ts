import { redirect } from "next/navigation";
import type { Actor } from "@/domain/actor";
import { loadShell } from "@/ui/shell/load-shell";

/** The signed-in coordinator or admin. Anyone else goes to their own start page. */
export async function coordinatorActor(): Promise<Actor> {
  const shell = await loadShell();
  if (!shell) redirect("/sign-in");
  if (shell.actor.role !== "coordinator" && shell.actor.role !== "admin") redirect("/");
  return shell.actor;
}
