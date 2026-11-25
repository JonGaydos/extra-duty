import type { Metadata } from "next";
import Link from "next/link";
import { withTx } from "@/ui/shell/request";
import { agencyNotificationSettings } from "@/domain/notifications/agency";
import { PageTitle } from "../../../_personnel/TabLinks";
import { managementActor } from "../../_admin/session";
import { NotificationMatrix } from "./NotificationMatrix";

export const metadata: Metadata = { title: "Notifications" };

/** Management > Notifications: which notifications go out by email and push, per recipient group. */
export default async function NotificationsPage() {
  const actor = await managementActor();
  const { channels } = await withTx((tx) => agencyNotificationSettings(actor, tx));
  return (
    <div className="flex flex-col gap-4.5">
      <p className="m-0 text-sm">
        <Link href="/admin">Management</Link>
      </p>
      <PageTitle sub="Turn email or push off for a whole group. When a switch is on, each person's own alert choices still apply. Every notification still goes to the in-app inbox. A dash means that group never gets it.">
        Notifications
      </PageTitle>
      <NotificationMatrix initial={channels} />
    </div>
  );
}
