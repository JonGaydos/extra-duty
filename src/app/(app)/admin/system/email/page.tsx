import type { Metadata } from "next";
import Link from "next/link";
import { eq } from "drizzle-orm";
import { withTx } from "@/ui/shell/request";
import { users } from "@/db/schema";
import { getSettings } from "@/domain/settings/settings";
import { emailConfigProblem } from "@/lib/email/provider";
import { Card } from "@/ui/components/Card";
import { Notice } from "@/ui/components/Notice";
import { PageTitle } from "../../../_personnel/TabLinks";
import { systemActor } from "../../_admin/session";
import { EmailSettingsForm, TestEmail } from "./EmailForm";

export const metadata: Metadata = { title: "Email" };

/** The provider every message goes out through. Secrets are write-only: this page only says whether they are set. */
export default async function EmailPage() {
  const actor = await systemActor();
  const { s, me } = await withTx(async (tx) => ({
    s: await getSettings(tx),
    me: (await tx.select({ email: users.email }).from(users).where(eq(users.id, actor.userId)))[0],
  }));
  const e = s.email;
  const problem = emailConfigProblem(e);
  return (
    <div className="flex flex-col gap-4.5">
      <p className="m-0 text-sm">
        <Link href="/admin/system">System</Link>
      </p>
      <PageTitle sub="Sign-in codes, invites, invoices and alerts all go out through this provider.">Email</PageTitle>
      {problem ? <Notice tone="warning">Email cannot go out yet: set {problem.what}.</Notice> : null}
      <div className="grid items-start gap-4.5 md:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        <Card>
          <EmailSettingsForm
            initial={{ provider: e.provider, from: e.from, host: e.smtp.host, port: String(e.smtp.port), secure: e.smtp.secure, user: e.smtp.user, region: e.region }}
            secrets={{ passwordSet: !!e.smtp.passwordEnc, apiKeySet: !!e.apiKeyEnc }}
          />
        </Card>
        <TestEmail to={me.email} />
      </div>
    </div>
  );
}
