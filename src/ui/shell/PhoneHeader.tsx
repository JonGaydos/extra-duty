import Link from "next/link";
import { AgencyLogo, type AgencyLogoData } from "../components/AgencyLogo";
import { AlertsBell } from "./AlertsBell";

/** Phones, for coordinators and admins: the brand and the alerts bell above every page (the tab bar has no room for it). */
export function PhoneHeader({ home, unreadAlerts, logo = null }: Readonly<{ home: string; unreadAlerts: number; logo?: AgencyLogoData | null }>) {
  return (
    <header data-shell="phone-header" className="border-b border-line bg-surface md:hidden">
      <div className="flex min-h-14 items-center justify-between gap-3 px-5 py-1.5">
        <Link href={home} data-nav-item className="flex items-center gap-2.5 text-lg font-bold text-ink no-underline hover:text-ink">
          {logo ? <AgencyLogo logo={logo} place="header" /> : null}
          Extra Duty
        </Link>
        <AlertsBell unread={unreadAlerts} size="md" />
      </div>
    </header>
  );
}
