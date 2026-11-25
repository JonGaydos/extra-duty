import { redirect } from "next/navigation";
import type { Actor } from "@/domain/actor";
import { loadShell } from "@/ui/shell/load-shell";

/** The signed-in person for a personnel screen. Vendors go to their own start page. */
export async function personnelActor(): Promise<Actor> {
  const shell = await loadShell();
  if (!shell) redirect("/sign-in");
  if (shell.actor.role === "vendor") redirect("/");
  return shell.actor;
}
