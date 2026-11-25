import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getActor } from "@/domain/auth/session";
import { navFor } from "@/ui/shell/nav";

/** Sends each role to its start page, or to sign-in. */
export default async function Root() {
  const actor = await getActor(await headers());
  redirect(actor ? navFor(actor.role).home : "/sign-in");
}
