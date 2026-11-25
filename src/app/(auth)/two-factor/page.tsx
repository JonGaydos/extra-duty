import type { Metadata } from "next";
import { AuthShell } from "@/ui/shell/AuthShell";
import { loadLogo, loadSettings } from "../settings";
import { TwoFactorForm } from "./two-factor-form";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Enter your sign-in code" };

export default async function TwoFactorPage() {
  const { security, agency } = await loadSettings();
  const logo = await loadLogo();
  return (
    <AuthShell agencyName={agency.name} logo={logo} title="Enter your sign-in code" footer={<a href="/sign-in">Back to sign in</a>}>
      <TwoFactorForm trustedDeviceDays={security.trustedDeviceDays} codeMinutes={security.emailCodeMinutes} />
    </AuthShell>
  );
}
