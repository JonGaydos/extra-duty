import { redirect } from "next/navigation";
import type { Actor } from "@/domain/actor";
import { loadShell } from "@/ui/shell/load-shell";

/** The signed-in vendor user. Anyone else goes to their own start page. */
export async function vendorActor(): Promise<Actor> {
  const shell = await loadShell();
  if (!shell) redirect("/sign-in");
  if (shell.actor.role !== "vendor") redirect("/");
  return shell.actor;
}
