import type { Metadata } from "next";
import { AuthShell } from "@/ui/shell/AuthShell";
import { loadLogo, loadSettings } from "../settings";
import { ForgotPasswordForm } from "./forgot-password-form";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Reset your password" };

export default async function ForgotPasswordPage() {
  const { agency } = await loadSettings();
  const logo = await loadLogo();
  return (
    <AuthShell agencyName={agency.name} logo={logo} title="Reset your password" footer={<a href="/sign-in">Back to sign in</a>}>
      <p className="m-0 text-muted">Enter your email address. If it belongs to an account, we will email you a reset link.</p>
      <ForgotPasswordForm />
    </AuthShell>
  );
}
