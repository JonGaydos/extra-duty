import type { Metadata } from "next";
import Link from "next/link";
import { withTx } from "@/ui/shell/request";
import { getSettings } from "@/domain/settings/settings";
import { Card } from "@/ui/components/Card";
import { Notice } from "@/ui/components/Notice";
import { PageTitle } from "../../../_personnel/TabLinks";
import { SettingsForm } from "../../_admin/forms";
import { GROUPS, groupValues } from "../../_admin/settings-groups";
import { systemActor } from "../../_admin/session";
import { saveSecurityGroupAction } from "../_system/actions";

export const metadata: Metadata = { title: "Security" };

/** Sign-in codes, trusted devices and passwords. Two-factor itself is always on. */
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
        <Notice tone="info">Two-factor sign-in is required for every account, with a 6-digit code sent by email. It cannot be turned off.</Notice>
        <SettingsForm slug={group.slug} fields={group.fields} initial={groupValues(group, s)} save={saveSecurityGroupAction} saveLabel={group.save} />
      </Card>
    </div>
  );
}
