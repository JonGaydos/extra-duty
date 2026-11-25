import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getActor } from "@/domain/auth/session";
import { navFor } from "@/ui/shell/nav";

/** A person who is still signed in (including after a sign-out that did not go through) goes to their start page. */
export default async function SignInLayout({ children }: { children: React.ReactNode }) {
  const actor = await getActor(await headers());
  if (actor) redirect(navFor(actor.role).home);
  return children;
}
