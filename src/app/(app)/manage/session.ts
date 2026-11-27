import { redirect } from "next/navigation";
import type { Actor } from "@/domain/actor";
import { isVendorManager } from "@/domain/auth/policy";
import { loadShell } from "@/ui/shell/load-shell";

/** A deputy who manages vendors (owner decision 2026-11-27). Anyone else goes to their own start page. */
export async function vendorManagerActor(): Promise<Actor> {
  const shell = await loadShell();
  if (!shell) redirect("/sign-in");
  if (!isVendorManager(shell.actor)) redirect("/");
  return shell.actor;
}

/** Staff, or a vendor manager: the people who may open New detail. */
export async function detailCreatorActor(): Promise<Actor> {
  const shell = await loadShell();
  if (!shell) redirect("/sign-in");
  const { actor } = shell;
  if (actor.role !== "coordinator" && actor.role !== "admin" && !isVendorManager(actor)) redirect("/");
  return actor;
}
