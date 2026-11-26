import type { Metadata } from "next";
import { withTx } from "@/ui/shell/request";
import { userDirectory } from "@/domain/admin/views";
import { listQualifications } from "@/domain/jobs/qualifications";
import { listRanks } from "@/domain/ranks/ranks";
import { Card } from "@/ui/components/Card";
import { Chip } from "@/ui/components/Chip";
import { EmptyState } from "@/ui/components/EmptyState";
import { Input } from "@/ui/components/FormField";
import { Icon } from "@/ui/icons";
import { PageTitle, TabLinks } from "../../_personnel/TabLinks";
import { Row, Rows } from "../../coordinate/_coordinator/ui";
import { managementActor } from "../_admin/session";
import { ROLE_LABEL } from "../_admin/labels";
import { InviteUser } from "./UserActions";

export const metadata: Metadata = { title: "Users" };

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };
type Show = "active" | "suspended" | "inactive";
type DirectoryUser = Awaited<ReturnType<typeof userDirectory>>[number];

const IN_LIST: Record<Show, (u: DirectoryUser) => boolean> = {
  active: (u) => u.active,
  suspended: (u) => u.active && u.suspended,
  inactive: (u) => !u.active,
};

function emptyText(q: string, show: Show): string {
  if (q) return "Nothing matches that name or email.";
  return show === "active" ? "People you invite show up here." : "Nobody is in this list right now.";
}

const rankSuffix = (u: DirectoryUser) => (u.rankName ? `, ${u.rankName}` : "");

/** Staff accounts (vendor logins live on each vendor): active, suspended and turned off; invite someone new. */
export default async function UsersPage({ searchParams }: Readonly<Props>) {
  const actor = await managementActor();
  const sp = await searchParams;
  const q = typeof sp.q === "string" ? sp.q.trim().toLowerCase() : "";
  const show: Show = sp.show === "suspended" || sp.show === "inactive" ? sp.show : "active";
  const { all, ranks, flags } = await withTx(async (tx) => ({
    all: await userDirectory(actor, tx),
    ranks: (await listRanks(tx)).filter((r) => r.active),
    flags: (await listQualifications(actor, tx)).filter((f) => f.active),
  }));
  const list = all.filter(IN_LIST[show]).filter((u) => !q || u.name.toLowerCase().includes(q) || u.email.includes(q));
  const search = q ? `&q=${encodeURIComponent(q)}` : "";
  const href = (s: string) => `/admin/users?show=${s}${search}`;

  return (
    <div className="flex flex-col gap-4.5">
      <PageTitle>Users</PageTitle>
      <InviteUser canInviteAdmins={actor.role === "admin"} ranks={ranks.map((r) => ({ id: r.id, name: r.name }))} flags={flags.map((f) => ({ id: f.id, name: f.name }))} />
      <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <TabLinks
          label="Which accounts"
          current={show}
          items={[
            { key: "active", label: `Active ${all.filter((u) => u.active).length}`, href: href("active") },
            { key: "suspended", label: `Suspended ${all.filter((u) => u.active && u.suspended).length}`, href: href("suspended") },
            { key: "inactive", label: `Turned off ${all.filter((u) => !u.active).length}`, href: href("inactive") },
          ]}
        />
        <form role="search" action="/admin/users" className="flex gap-2">
          <input type="hidden" name="show" value={show} />
          <Input name="q" defaultValue={q} aria-label="Search users" placeholder="Name or email" className="md:w-64" />
          <button type="submit" className="flex size-11 shrink-0 items-center justify-center rounded-sm border border-line bg-surface hover:bg-subtle" aria-label="Search">
            <Icon name="search" size={20} />
          </button>
        </form>
      </div>
      {list.length === 0 ? (
        <Card pad={false}>
          <EmptyState title="No accounts here">{emptyText(q, show)}</EmptyState>
        </Card>
      ) : (
        <Rows>
          {list.map((u) => (
            <Row
              key={u.id}
              title={u.name}
              href={`/admin/users/${u.id}`}
              meta={`${u.email}. ${ROLE_LABEL[u.role]}${rankSuffix(u)}`}
              actions={
                u.suspended || u.lockedAt || u.role !== "personnel" ? (
                  <>
                    {u.role === "admin" || u.role === "coordinator" ? <Chip tone="coordinator">{ROLE_LABEL[u.role]}</Chip> : null}
                    {u.suspended ? <Chip tone="danger">Suspended</Chip> : null}
                    {u.lockedAt ? <Chip tone="warning">Locked</Chip> : null}
                  </>
                ) : null
              }
            />
          ))}
        </Rows>
      )}
    </div>
  );
}
