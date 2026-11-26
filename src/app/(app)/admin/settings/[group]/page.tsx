import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { withTx } from "@/ui/shell/request";
import { reviewerOptions } from "@/domain/admin/views";
import { listPositionTypes } from "@/domain/jobs/job-types";
import { getSettings } from "@/domain/settings/settings";
import { Card } from "@/ui/components/Card";
import { PageTitle } from "../../../_personnel/TabLinks";
import { saveSettingsAction } from "../../_admin/actions";
import { SettingsForm } from "../../_admin/forms";
import { managementActor } from "../../_admin/session";
import { GROUPS, PAGE_GROUPS, groupValues } from "../../_admin/settings-groups";
import { ROLE_LABEL } from "../../_admin/labels";

type Props = { params: Promise<{ group: string }> };

const groupOf = (slug: string) => ((PAGE_GROUPS as readonly string[]).includes(slug) ? GROUPS[slug as (typeof PAGE_GROUPS)[number]] : null);

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  return { title: groupOf((await params).group)?.title ?? "Settings" };
}

/** One group of agency rules on one page with one Save. */
export default async function SettingsGroupPage({ params }: Readonly<Props>) {
  const actor = await managementActor();
  const group = groupOf((await params).group);
  if (!group) notFound();
  const { settings, positions, reviewers } = await withTx(async (tx) => ({
    settings: await getSettings(tx),
    positions: group.fields.some((f) => f.kind === "positionType") ? (await listPositionTypes(actor, tx)).filter((p) => p.active) : [],
    reviewers: group.fields.some((f) => f.kind === "reviewers") ? await reviewerOptions(actor, tx) : [],
  }));
  return (
    <div className="flex flex-col gap-4.5">
      <p className="m-0 text-sm">
        <Link href="/admin">Management</Link>
      </p>
      <PageTitle sub={group.intro}>{group.title}</PageTitle>
      <Card className="max-w-240">
        <SettingsForm
          slug={group.slug}
          fields={group.fields}
          initial={groupValues(group, settings)}
          save={saveSettingsAction}
          saveLabel={group.save}
          options={{
            positionType: positions.map((p) => ({ id: p.id, name: p.name })),
            reviewers: reviewers.map((r) => ({ id: r.id, name: `${r.name} (${ROLE_LABEL[r.role]})` })),
          }}
        />
      </Card>
    </div>
  );
}
