import type { Metadata } from "next";
import { Notice } from "@/ui/components/Notice";
import { AuthShell } from "@/ui/shell/AuthShell";
import { loadLogo, loadSettings } from "../settings";
import { ResetPasswordForm } from "./reset-password-form";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Set a new password" };

type Props = { searchParams: Promise<{ token?: string; error?: string }> };

export default async function ResetPasswordPage({ searchParams }: Readonly<Props>) {
  const { token, error } = await searchParams;
  const { security, agency } = await loadSettings();
  const logo = await loadLogo();
  return (
    <AuthShell agencyName={agency.name} logo={logo} title="Set a new password" footer={<a href="/sign-in">Back to sign in</a>}>
      {token && !error ? (
        <ResetPasswordForm token={token} minLength={security.passwordMinLength} />
      ) : (
        <Notice tone="danger">
          This reset link is not valid or has expired. <a href="/forgot-password">Request a new link</a>.
        </Notice>
      )}
    </AuthShell>
  );
}
