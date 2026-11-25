import type { Metadata } from "next";
import { withTx } from "@/ui/shell/request";
import { agencyLogoInfo } from "@/domain/settings/logo";
import { getSettings } from "@/domain/settings/settings";
import { initialsOf } from "@/domain/users/profile";
import { Card, CardTitle } from "@/ui/components/Card";
import { PageTitle } from "../../_personnel/TabLinks";
import { saveSettingsAction } from "../_admin/actions";
import { SettingsForm } from "../_admin/forms";
import { managementActor } from "../_admin/session";
import { GROUPS, groupValues } from "../_admin/settings-groups";
import { LogoUpload } from "./LogoUpload";

export const metadata: Metadata = { title: "Agency profile" };

/** The agency's name, Sheriff, contact lines and logo, as invoices print them. */
export default async function AgencyPage() {
  await managementActor();
  const { settings, logo } = await withTx(async (tx) => ({ settings: await getSettings(tx), logo: await agencyLogoInfo(tx).catch(() => null) }));
  const group = GROUPS.agency;
  return (
    <div className="flex flex-col gap-4.5">
      <PageTitle sub="Printed at the top of every invoice and shown at sign-in.">Agency profile</PageTitle>
      <div className="grid items-start gap-4.5 md:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
        <Card>
          <CardTitle>Details</CardTitle>
          <SettingsForm slug={group.slug} fields={group.fields} initial={groupValues(group, settings)} save={saveSettingsAction} saveLabel={group.save} />
        </Card>
        <Card>
          <CardTitle>Logo</CardTitle>
          <LogoUpload key={logo?.fileId ?? "none"} logo={logo} initials={initialsOf(settings.agency.name)} />
        </Card>
      </div>
    </div>
  );
}
