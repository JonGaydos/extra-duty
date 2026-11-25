import type { Metadata } from "next";
import { Notice } from "@/ui/components/Notice";
import { AuthShell } from "@/ui/shell/AuthShell";
import { loadLogo, loadSettings } from "../settings";
import { AcceptInviteForm } from "./accept-invite-form";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Set up your account" };

type Props = { searchParams: Promise<{ token?: string }> };

export default async function AcceptInvitePage({ searchParams }: Props) {
  const { token } = await searchParams;
  const { security, agency } = await loadSettings();
  const logo = await loadLogo();
  return (
    <AuthShell agencyName={agency.name} logo={logo} title="Set up your account">
      {token ? (
        <>
          <p className="m-0 text-muted">Choose a password. You will use it with a 6-digit code we email you each time you sign in.</p>
          <AcceptInviteForm token={token} minLength={security.passwordMinLength} />
        </>
      ) : (
        <Notice tone="danger">This invite link is not valid. Ask a coordinator for a new invite.</Notice>
      )}
    </AuthShell>
  );
}
