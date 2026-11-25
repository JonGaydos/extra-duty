import type { Metadata } from "next";
import Link from "next/link";
import { withTx } from "@/ui/shell/request";
import { getSettings } from "@/domain/settings/settings";
import { emailConfigProblem } from "@/lib/email/provider";
import { Card, CardTitle } from "@/ui/components/Card";
import { Chip } from "@/ui/components/Chip";
import { PageTitle } from "../../_personnel/TabLinks";
import { Facts } from "../../coordinate/_coordinator/ui";
import { systemActor } from "../_admin/session";
import { PROVIDER_LABEL } from "./labels";

export const metadata: Metadata = { title: "System" };

/** Admin-only settings: the email provider, sign-in security and API access. */
export default async function SystemPage() {
  await systemActor();
  const s = await withTx((tx) => getSettings(tx));
  const problem = emailConfigProblem(s.email);
  return (
    <div className="flex flex-col gap-4.5">
      <p className="m-0 text-sm">
        <Link href="/admin">Management</Link>
      </p>
      <PageTitle sub="Admins only. Coordinators cannot open these pages.">System</PageTitle>
      <div className="grid items-start gap-4.5 md:grid-cols-2">
        <Card>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <CardTitle>
              <Link href="/admin/system/email" className="text-ink hover:text-link">
                Email
              </Link>
            </CardTitle>
            {problem ? <Chip tone="danger">Not set up</Chip> : <Chip tone="success">Ready</Chip>}
          </div>
          <Facts
            items={[
              ["Provider", PROVIDER_LABEL[s.email.provider]],
              ["Sends as", s.email.from || "Not set"],
              ...(problem ? ([["Missing", problem.what]] as Array<[string, string]>) : []),
            ]}
          />
        </Card>
        <Card>
          <CardTitle>
            <Link href="/admin/system/security" className="text-ink hover:text-link">
              Security
            </Link>
          </CardTitle>
          <Facts
            items={[
              ["Two-factor", "Required for every account"],
              ["Sign-in codes", `Last ${s.security.emailCodeMinutes} minutes`],
              ["Trusted devices", `${s.security.trustedDeviceDays} days`],
              ["Passwords", `At least ${s.security.passwordMinLength} characters`],
            ]}
          />
        </Card>
        <Card id="api-keys">
          <CardTitle>
            <Link href="/admin/api" className="text-ink hover:text-link">
              API access
            </Link>
          </CardTitle>
          <p className="m-0 text-muted">Keys that let other systems read and change Extra Duty data, and the API reference.</p>
        </Card>
      </div>
    </div>
  );
}
