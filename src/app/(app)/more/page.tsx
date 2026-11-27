import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Card } from "@/ui/components/Card";
import { Icon } from "@/ui/icons";
import { loadShell } from "@/ui/shell/load-shell";
import { navFor, type NavItem } from "@/ui/shell/nav";
import { isVendorManager } from "@/domain/auth/policy";
import { appEnvFromProcess } from "@/lib/env";
import { trainingConfigured } from "@/db/client";
import { PRACTICE_ROLE_LABELS } from "@/domain/training/mode";
import { BackToLiveButton, TrainingSwitch } from "@/ui/shell/TrainingSwitch";
import { backToLiveAction, switchToTrainingAction } from "@/ui/shell/training-actions";

export const metadata: Metadata = { title: "More" };

/** One group of More rows. */
function Rows({ items, label }: Readonly<{ items: NavItem[]; label?: string }>) {
  return (
    <Card pad={false} className="max-w-140">
      <ul aria-label={label} className="m-0 list-none p-0">
        {items.map((i) => (
          <li key={i.href} className="border-t border-divider first:border-t-0">
            <Link href={i.href} data-nav-item className="flex min-h-13 items-center gap-3.5 px-4 text-title font-medium text-ink no-underline hover:text-ink">
              <Icon name={i.icon} size={22} className="text-muted" />
              <span className="flex-1">{i.label}</span>
              <Icon name="chevronRight" size={18} className="text-muted" />
            </Link>
          </li>
        ))}
      </ul>
    </Card>
  );
}

/**
 * Phone only in practice: the sections that do not fit in the tab bar, then, for coordinators and admins, their staff
 * sections in a group of their own and, where training is set up, the training switch (the desktop top bar's, which
 * phones do not show). A role with nothing here goes Home.
 */
export default async function MorePage() {
  const shell = await loadShell();
  if (!shell) redirect("/sign-in");
  const nav = navFor(shell.actor.role, { outbox: shell.mode === "training" || appEnvFromProcess() === "staging", manager: isVendorManager(shell.actor) });
  const training = shell.mode === "training";
  const canTrain = (shell.userRole === "coordinator" || shell.userRole === "admin") && trainingConfigured();
  if (nav.more.length === 0 && !canTrain) redirect(nav.home);
  const items = nav.more;
  // A vendor manager's Manage tab is their only extra section.
  const staffGroup = shell.actor.role === "personnel" ? "Vendor manager" : "Staff";
  return (
    <div className="flex flex-col gap-5">
      <h1 className="m-0 text-2xl font-bold md:text-3xl">More</h1>
      {canTrain ? (
        <section aria-label="Training" className="flex max-w-140 flex-col gap-2">
          <h2 className="m-0 text-title font-semibold">Training</h2>
          <Card as="div" className="flex flex-col gap-3">
            {training ? (
              <>
                <p className="m-0 text-sm text-muted">You are practicing as {shell.practiceRole ? PRACTICE_ROLE_LABELS[shell.practiceRole] : "Deputy"} on made-up data.</p>
                <BackToLiveButton backToLive={backToLiveAction} />
              </>
            ) : (
              <>
                <p className="m-0 text-sm text-muted">Practice on made-up data as a deputy, coordinator, admin or vendor. Nothing you do there is real.</p>
                <TrainingSwitch switchMode={switchToTrainingAction} />
              </>
            )}
          </Card>
        </section>
      ) : null}
      {items.length ? <Rows items={items} /> : null}
      {nav.staff.length ? (
        <section aria-labelledby="more-staff" className="flex max-w-140 flex-col gap-2">
          <h2 id="more-staff" className="m-0 text-title font-semibold">
            {staffGroup}
          </h2>
          <Rows items={nav.staff} label={staffGroup} />
        </section>
      ) : null}
    </div>
  );
}
