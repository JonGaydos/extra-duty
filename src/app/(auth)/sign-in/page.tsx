import type { Metadata } from "next";
import { inactivityNotice } from "@/domain/auth/inactivity";
import { Icon } from "@/ui/icons";
import { AuthShell } from "@/ui/shell/AuthShell";
import { loadLogo, loadSettings } from "../settings";
import { SignInForm } from "./sign-in-form";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Sign in" };

export default async function SignInPage() {
  const { inactivityLockDays, agency } = await loadSettings();
  const logo = await loadLogo();
  return (
    <AuthShell
      agencyName={agency.name} logo={logo}
      title="Sign in"
      footer="After your password, we may email you a 6-digit code to finish signing in."
    >
      <SignInForm />
      <p className="m-0 flex flex-col gap-2 border-t border-divider pt-3.5">
        <a href="/forgot-password" className="flex min-h-11 w-fit items-center text-body font-semibold">
          Forgot password?
        </a>
        <span className="flex items-start gap-2 rounded-md bg-warning-soft px-3 py-2.5 text-sm text-warning-ink">
          <Icon name="info" size={16} strokeWidth={2} className="mt-0.5 shrink-0" />
          <span>{inactivityNotice(inactivityLockDays)} Use Forgot password to reset it yourself.</span>
        </span>
      </p>
    </AuthShell>
  );
}
