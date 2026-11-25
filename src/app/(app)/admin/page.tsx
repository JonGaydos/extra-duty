import type { Metadata } from "next";
import { withTx } from "@/ui/shell/request";
import { accessReviewOverview, flagOverview, userDirectory } from "@/domain/admin/views";
import { listSeasons } from "@/domain/caps/seasons";
import { listJobTypes, listNotePresets, listPaymentMethods, listPositionTypes, listVendorTypes } from "@/domain/jobs/job-types";
import { listRanks } from "@/domain/ranks/ranks";
import { getSettings } from "@/domain/settings/settings";
import { emailConfigProblem } from "@/lib/email/provider";
import { Chip } from "@/ui/components/Chip";
import { PageTitle } from "../_personnel/TabLinks";
import { hhmmText, hoursText, plural } from "../_personnel/format";
import { CountSection, Row, Rows } from "../coordinate/_coordinator/ui";
import { managementActor } from "./_admin/session";
import { PROVIDER_LABEL } from "./system/labels";

export const metadata: Metadata = { title: "Management" };

const ordinal = (n: number) => `${n}${n % 100 >= 11 && n % 100 <= 13 ? "th" : (["th", "st", "nd", "rd"][n % 10] ?? "th")}`;
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

type Link = { title: string; href: string; meta: string; flag?: React.ReactNode };

function Group({ title, links }: { title: string; links: Link[] }) {
  return (
    <CountSection title={title}>
      <Rows>
        {links.map((l) => (
          <Row key={l.href} title={l.title} href={l.href} meta={l.meta} actions={l.flag} />
        ))}
      </Rows>
    </CountSection>
  );
}

/** Every rule, list and person the agency manages, each with its current state in one line. */
export default async function ManagementPage() {
  const actor = await managementActor();
  const data = await withTx(async (tx) => ({
    settings: await getSettings(tx),
    users: await userDirectory(actor, tx),
    flags: await flagOverview(actor, tx),
    review: await accessReviewOverview(actor, tx),
    ranks: await listRanks(tx),
    seasons: await listSeasons(actor, tx),
    counts: {
      positions: (await listPositionTypes(actor, tx)).filter((r) => r.active).length,
      jobTypes: (await listJobTypes(actor, tx)).filter((r) => r.active).length,
      vendorTypes: (await listVendorTypes(actor, tx)).filter((r) => r.active).length,
      paymentMethods: (await listPaymentMethods(actor, tx)).filter((r) => r.active).length,
      presets: (await listNotePresets(actor, tx)).filter((r) => r.active).length,
    },
  }));
  const { settings: s, users, flags, review, ranks, seasons, counts } = data;
  const active = users.filter((u) => u.active);
  const suspended = active.filter((u) => u.suspended).length;
  const ladder = ranks.filter((r) => r.active && r.inLadder).map((r) => r.name);
  const outside = ranks.filter((r) => r.active && !r.inLadder).map((r) => r.name);
  const reviewers = s.opsPlanReviewerUserIds.length;
  const offSwitches = Object.values(s.notificationChannels).flatMap((g) => Object.values(g ?? {}).flatMap((c) => Object.values(c ?? {}))).filter((on) => on === false).length;
  const emailProblem = emailConfigProblem(s.email);
  const [mm, dd] = s.accessReviewMonthDay.split("-").map(Number);
  const reviewDate = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "short", day: "numeric" }).format(new Date(Date.UTC(2024, mm - 1, dd)));
  const capText = (m: number | null) => (m === null ? "no week cap" : `${hoursText(m)} a week`);

  return (
    <div className="flex flex-col gap-4.5">
      <PageTitle sub="Rules, lists and people for the whole agency. Every change is kept in the audit log.">Management</PageTitle>
      <div className="grid items-start gap-6 md:grid-cols-2">
        <div className="flex flex-col gap-6">
          <Group
            title="People"
            links={[
              { title: "Users", href: "/admin/users", meta: `${plural(active.length, "active account")}${suspended ? `, ${suspended} suspended` : ""}` },
              { title: "Ranks", href: "/admin/ranks", meta: `${ladder.join(", ")}${outside.length ? `. Outside the ladder: ${outside.join(", ")}` : ""}` },
              {
                title: "Special flags",
                href: "/admin/flags",
                meta: plural(flags.flags.filter((f) => f.active).length, "flag"),
                flag: flags.requests.length ? <Chip tone="attention">{plural(flags.requests.length, "request")} waiting</Chip> : undefined,
              },
              {
                title: "Access review",
                href: "/admin/access-review",
                meta: review.open ? `Open: ${review.open.decided} of ${review.open.total} decided` : `Next on ${reviewDate}, every ${plural(s.accessReviewEveryMonths, "month")}`,
                flag: review.open ? <Chip tone="attention">In progress</Chip> : undefined,
              },
            ]}
          />
          <Group
            title="Sign-up rules"
            links={[
              {
                title: "Seasons and caps",
                href: "/admin/seasons",
                meta: seasons.length ? seasons.map((x) => `${x.name}: ${capText(x.weekCapMinutes)}`).join(". ") : "No seasons, so no hour caps apply",
              },
              { title: "Release", href: "/admin/settings/release", meta: `The ${ordinal(s.releaseDayOfMonth)} of the month before, at ${hhmmText(s.releaseTime)}` },
              { title: "Sign-up", href: "/admin/settings/signup", meta: `Weeks start on ${WEEKDAYS[s.weekStartsOn]}. Rolling cap over ${s.rollingCapWindowHours} hours` },
              { title: "Vendor limits", href: "/admin/settings/vendors", meta: `Requests need ${s.vendorMinNoticeHours} hours notice` },
              { title: "Ops plan review", href: "/admin/settings/ops-plans", meta: reviewers ? plural(reviewers, "reviewer") : "No reviewers chosen" },
            ]}
          />
          <Group
            title="Billing"
            links={[
              { title: "Billing and invoices", href: "/admin/settings/billing", meta: `Minimum ${hoursText(s.minimumBillableMinutes)}. Invoice numbers start ${s.invoiceNumberPrefix || "with no prefix"}` },
              { title: "Reminders and locks", href: "/admin/settings/reminders", meta: `Billing lock ${s.billingLockEnabled ? "on" : "off"}. Accounts lock after ${s.inactivityLockDays} unused days` },
            ]}
          />
        </div>
        <div className="flex flex-col gap-6">
          <Group
            title="Lists"
            links={[
              { title: "Position types", href: "/admin/positions", meta: counts.positions ? plural(counts.positions, "position type") : "None yet" },
              { title: "Job types", href: "/admin/lists/job-types", meta: counts.jobTypes ? plural(counts.jobTypes, "job type") : "None yet" },
              { title: "Vendor types", href: "/admin/lists/vendor-types", meta: counts.vendorTypes ? plural(counts.vendorTypes, "vendor type") : "None yet" },
              { title: "Payment methods", href: "/admin/lists/payment-methods", meta: counts.paymentMethods ? plural(counts.paymentMethods, "payment method") : "None yet" },
              { title: "Note presets", href: "/admin/note-presets", meta: counts.presets ? plural(counts.presets, "preset") : "None yet" },
            ]}
          />
          <Group
            title="Agency"
            links={[
              { title: "Agency profile", href: "/admin/agency", meta: `${s.agency.name}${s.agency.logoFileId ? ", with logo" : ", no logo yet"}` },
              { title: "Notifications", href: "/admin/settings/notifications", meta: offSwitches ? `${plural(offSwitches, "switch", "switches")} turned off` : "Every email and push is on" },
              { title: "Map", href: "/admin/settings/map", meta: `Opens at ${s.mapDefaultCenter.lat}, ${s.mapDefaultCenter.lng}` },
              { title: "Audit log", href: "/admin/audit", meta: "Every change, newest first" },
            ]}
          />
          {actor.role === "admin" ? (
            <Group
              title="System"
              links={[
                {
                  title: "Email",
                  href: "/admin/system/email",
                  meta: emailProblem ? `Not ready: set ${emailProblem.what}` : `${PROVIDER_LABEL[s.email.provider]}, sending as ${s.email.from}`,
                  flag: emailProblem ? <Chip tone="danger">Not set up</Chip> : <Chip tone="success">Ready</Chip>,
                },
                { title: "Security", href: "/admin/system/security", meta: `Codes last ${s.security.emailCodeMinutes} minutes. Trusted devices ${s.security.trustedDeviceDays} days` },
                { title: "API access", href: "/admin/api", meta: "Keys for other systems, and the API reference" },
              ]}
            />
          ) : null}
        </div>
      </div>
    </div>
  );
}
