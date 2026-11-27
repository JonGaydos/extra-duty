import type { Metadata } from "next";
import Link from "next/link";
import { withTx } from "@/ui/shell/request";
import { ADMIN_CODES_REASON, getSettings } from "@/domain/settings/settings";
import { Card, CardTitle } from "@/ui/components/Card";
import { PageTitle } from "../../../_personnel/TabLinks";
import { SettingsForm } from "../../_admin/forms";
import { GROUPS, groupValues } from "../../_admin/settings-groups";
import { systemActor } from "../../_admin/session";
import { saveSecurityGroupAction } from "../_system/actions";
import { SignInCodesForm } from "./SignInCodesForm";

export const metadata: Metadata = { title: "Security" };

/** Sign-in codes (required per role, always for admins), trusted devices and passwords. */
export default async function SecurityPage() {
  await systemActor();
  const s = await withTx((tx) => getSettings(tx));
  const group = GROUPS.security;
  return (
    <div className="flex flex-col gap-4.5">
      <p className="m-0 text-sm">
        <Link href="/admin/system">System</Link>
      </p>
      <PageTitle sub={group.intro}>Security</PageTitle>
      <Card className="max-w-240">
        <CardTitle>Require emailed sign-in codes</CardTitle>
        <p className="m-0 text-muted">After the password, each person enters a 6-digit code sent to their email. On for every role unless you turn it off here.</p>
        <SignInCodesForm initial={{ coordinator: s.security.signInCodes.coordinator, personnel: s.security.signInCodes.personnel, vendor: s.security.signInCodes.vendor }} adminReason={ADMIN_CODES_REASON} />
      </Card>
      <Card className="max-w-240">
        <CardTitle>Codes, devices and passwords</CardTitle>
        <SettingsForm slug={group.slug} fields={group.fields} initial={groupValues(group, s)} save={saveSecurityGroupAction} saveLabel={group.save} />
      </Card>
    </div>
  );
}
