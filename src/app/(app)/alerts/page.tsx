import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { withTx } from "@/ui/shell/request";
import { listAlerts, unreadAlertCount } from "@/domain/notifications/inbox";
import { Card } from "@/ui/components/Card";
import { EmptyState } from "@/ui/components/EmptyState";
import { loadShell } from "@/ui/shell/load-shell";
import { dateTime } from "../_personnel/format";
import { AlertList } from "./AlertList";

export const metadata: Metadata = { title: "Alerts" };

/** The person's in-app alerts, newest first. Each links to what it is about; mark one or all read. */
export default async function AlertsPage() {
  const shell = await loadShell();
  if (!shell) redirect("/sign-in");
  const { actor } = shell;
  const data = await withTx(async (tx) => ({ alerts: await listAlerts(actor, tx), unread: await unreadAlertCount(actor, tx) }));
  return (
    <div className="mx-auto flex w-full max-w-200 flex-col gap-4.5">
      <div className="flex flex-col gap-1">
        <h1 className="m-0 text-2xl font-bold md:text-3xl">Alerts</h1>
        <p className="m-0 text-muted">{data.unread === 0 ? "You are all caught up." : `${data.unread} unread`}</p>
      </div>
      {data.alerts.length === 0 ? (
        <Card pad={false}>
          <EmptyState title="No alerts yet">Openings, changes, billing reminders and payments show here.</EmptyState>
        </Card>
      ) : (
        <AlertList unread={data.unread} alerts={data.alerts.map((a) => ({ id: a.id, title: a.title, body: a.body, link: a.link, when: dateTime(a.at), read: a.read }))} />
      )}
    </div>
  );
}
