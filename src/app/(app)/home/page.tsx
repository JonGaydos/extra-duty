import type { Metadata } from "next";
import Link from "next/link";
import { withTx } from "@/ui/shell/request";
import { unreadMessageCount } from "@/domain/messages/messages";
import { unreadAlertCount } from "@/domain/notifications/inbox";
import { capSummary, loadJobCards, myDetails, myInvoices, toBill, type CapUse } from "@/domain/personnel/views";
import { goalProgress, recommendationsFor } from "@/domain/planning/recommend";
import { ButtonLink } from "@/ui/components/Button";
import { Card, CardTitle } from "@/ui/components/Card";
import { Chip } from "@/ui/components/Chip";
import { EmptyState } from "@/ui/components/EmptyState";
import { dollars, PayLabel } from "@/ui/components/PayLabel";
import { StatTile } from "@/ui/components/StatTile";
import { Icon } from "@/ui/icons";
import { loadShell } from "@/ui/shell/load-shell";
import { dayLabel, longDay, plural, timeRange, wholeHours } from "../_personnel/format";
import { JobRow, RowList } from "../_personnel/JobRow";
import { filteredJobs, parseFilters } from "../_personnel/filters";
import { AlertsBell } from "@/ui/shell/AlertsBell";
import { personnelActor } from "../_personnel/session";
import { Section } from "../_personnel/TabLinks";

export const metadata: Metadata = { title: "Home" };

const DAY_MS = 86_400_000;

/** "1 waiting on the vendor. 1 needs you to confirm payment." Zero counts are left out. */
function waitingText(total: number, vendor: number, you: number, office: number, review: number, queued: number): string {
  if (total === 0) return "Nothing owed right now.";
  const parts = [
    you ? `${plural(you, "invoice needs", "invoices need")} you to confirm payment` : null,
    vendor ? `${vendor} waiting on the vendor` : null,
    office ? `${office} with the extra duty office` : null,
    review ? `${review} in review` : null,
    queued ? `${queued} queued for the next invoice send` : null,
  ].filter(Boolean);
  return `${parts.join(". ")}.`;
}

function capTile(label: string, use: CapUse) {
  if (use.limitMinutes === null) return <StatTile label={label} value={wholeHours(use.usedMinutes)} unit="h" />;
  const close = use.usedMinutes >= use.limitMinutes * 0.8;
  return <StatTile label={label} value={wholeHours(use.usedMinutes)} unit={`/ ${wholeHours(use.limitMinutes)} h`} tone={close ? "warning" : "default"} />;
}

/** The deputy's start page: goal, caps, what to bill, what is next, what is open, and what is owed. */
export default async function HomePage() {
  const actor = await personnelActor();
  const shell = (await loadShell())!;
  const now = new Date();
  const data = await withTx(async (tx) => {
    // One transaction holds one connection, so these run one after another.
    const goal = await goalProgress(actor, tx, now);
    const recs = await recommendationsFor(actor, tx, now);
    const caps = await capSummary(actor, tx, now);
    const bill = await toBill(actor, tx, now);
    const mine = await myDetails(actor, tx, now, { from: new Date(now.getTime() - DAY_MS) });
    const invoices = await myInvoices(actor, tx, now);
    const unread = await unreadMessageCount(actor, tx);
    const alerts = await unreadAlertCount(actor, tx);
    // Same window and query as the Details list with Open on, so "See all N" matches it.
    const open = (await filteredJobs(actor, tx, { ...parseFilters({}), open: true }, now)).cards;
    const recCards = await loadJobCards(actor, tx, recs, now);
    return { goal, recs: recCards, caps, bill, mine, invoices, unread, alerts, open };
  });

  // Canceled sign-ups stay in view (as Canceled, with the reason) rather than vanishing.
  const upNext = data.mine.filter((d) => ["signed_up", "pending_short", "backup", "canceled", "removed"].includes(d.status) && d.plannedEndAt > now).slice(0, 4);
  const waiting = data.invoices.filter((i) => i.status === "sent" || i.status === "pending_review" || i.status === "ready_to_send" || i.status === "approved_unsent");
  const waitingTotal = waiting.reduce((n, i) => n + i.totalCents, 0);
  const turns = (t: string) => waiting.filter((i) => i.turn === t).length;
  const first = shell.profile.name.split(/\s+/)[0];
  const goal = data.goal;
  const pct = (c: number) => (goal.goalCents ? Math.min(100, (c / goal.goalCents) * 100) : 0);
  const monthName = new Intl.DateTimeFormat("en-US", { timeZone: "America/Chicago", month: "long" }).format(now);

  return (
    <div className="flex flex-col gap-4.5 md:gap-6">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <span aria-hidden className="flex size-11 items-center justify-center rounded-full bg-accent-soft font-bold text-link">
            {shell.profile.initials}
          </span>
          <div className="flex flex-col">
            <span className="text-sm text-muted">
              <span className="md:hidden">{dayLabel(now)}</span>
              <span className="hidden md:inline">{longDay(now)}</span>
            </span>
            <h1 className="m-0 text-xl font-bold md:text-3xl">Hi, {first}</h1>
          </div>
        </div>
        <div className="flex gap-2">
          <Link
            href="/calendar"
            aria-label="Calendar"
            data-button-link className="flex size-11 items-center justify-center rounded-full border border-line bg-surface text-ink no-underline hover:bg-subtle hover:text-ink"
          >
            <Icon name="calendar" size={20} />
          </Link>
          <Link
            href="/messages"
            aria-label={data.unread > 0 ? `Messages, ${data.unread} unread` : "Messages"}
            data-button-link className="relative flex size-11 items-center justify-center rounded-full border border-line bg-surface text-ink no-underline hover:bg-subtle hover:text-ink"
          >
            <Icon name="mail" size={20} />
            {data.unread > 0 ? <span className="absolute top-2.25 right-2.25 size-2.5 rounded-full border-2 border-surface bg-attention-dot" /> : null}
          </Link>
          <span className="md:hidden">
            <AlertsBell unread={data.alerts} size="md" />
          </span>
        </div>
      </div>

      <div className="grid gap-4.5 md:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)] md:items-start md:gap-6">
        <div className="flex flex-col gap-4.5 md:gap-6">
          {goal.goalCents !== null ? (
            <Card>
              <div className="flex items-baseline justify-between">
                <CardTitle>{monthName} goal</CardTitle>
                <span className="text-title font-bold" data-numeric>
                  {dollars(goal.goalCents)}
                </span>
              </div>
              <div
                role="img"
                aria-label={`${dollars(goal.earnedCents)} earned and ${dollars(goal.signedUpCents)} signed up of a ${dollars(goal.goalCents)} goal`}
                className="flex h-2.5 overflow-hidden rounded-full bg-sunken"
              >
                <span className="bg-accent" style={{ width: `${pct(goal.earnedCents)}%` }} />
                <span className="bg-accent-muted" style={{ width: `${Math.max(0, pct(goal.earnedCents + goal.signedUpCents) - pct(goal.earnedCents))}%` }} />
              </div>
              <p className="m-0 flex flex-wrap gap-x-4 gap-y-1 text-sm text-muted" data-numeric>
                <span>
                  <b className="text-ink">{dollars(goal.earnedCents)}</b> earned
                </span>
                <span>
                  <b className="text-ink">{dollars(goal.signedUpCents)}</b> signed up
                </span>
                <span>
                  <b className="text-ink">{dollars(goal.remainingCents)}</b> to go
                </span>
              </p>
              {data.recs.length > 0 ? (
                <div className="flex flex-col gap-2 border-t border-divider pt-3">
                  <h3 className="m-0 text-sm font-semibold">Recommended for you</h3>
                  <ul className="m-0 flex list-none flex-col gap-2 p-0">
                    {data.recs.map((r) => (
                      <li key={r.id} className="flex items-center justify-between gap-3">
                        <span className="flex min-w-0 flex-col">
                          <Link href={`/jobs/${r.id}`} className="font-medium">
                            {r.vendorName}
                          </Link>
                          <span className="text-sm text-muted">
                            {dayLabel(r.startAt)}, {timeRange(r.startAt, r.endAt)}. <PayLabel variant="plain" totalCents={r.totalCents} rateCents={r.rateCents} />
                          </span>
                        </span>
                        <ButtonLink href={`/jobs/${r.id}#sign-up`} size="sm" aria-label={`Sign up for ${r.vendorName} on ${dayLabel(r.startAt)}`}>
                          Sign up
                        </ButtonLink>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : goal.remainingCents > 0 ? (
                <p className="m-0 text-sm text-muted">No open details fit your schedule and caps right now.</p>
              ) : null}
            </Card>
          ) : (
            <Card>
              <CardTitle>Monthly goal</CardTitle>
              <p className="m-0 text-muted">Set a monthly earnings goal in Profile to get recommended details that fit your schedule.</p>
              <Link href="/profile#goal" className="text-sm font-semibold">
                Set a goal
              </Link>
            </Card>
          )}

          <section aria-label="Hours against your caps" className="grid grid-cols-3 gap-2.5">
            {capTile(`Any ${data.caps.windowHours} hours`, data.caps.rolling)}
            {capTile("This week", data.caps.week)}
            {capTile(monthName, data.caps.month)}
          </section>

          {data.bill.length > 0 ? (
            <Card tone="accent">
              <div className="flex items-center justify-between gap-2">
                <CardTitle>Ready to bill</CardTitle>
                {data.bill.length > 1 ? <Chip tone="attention">{plural(data.bill.length, "detail")}</Chip> : null}
              </div>
              <div className="flex items-start justify-between gap-3">
                <span className="flex flex-col">
                  <span className="font-semibold">{data.bill[0].vendorName}</span>
                  <span className="text-sm text-muted">
                    {dayLabel(data.bill[0].startAt)}, {timeRange(data.bill[0].startAt, data.bill[0].endAt)}
                  </span>
                </span>
                <PayLabel totalCents={data.bill[0].totalCents} rateCents={data.bill[0].rateCents} />
              </div>
              <ButtonLink href={`/billing/bill/${data.bill[0].assignmentId}`} size="lg" full>
                Review and send invoice
              </ButtonLink>
            </Card>
          ) : null}

          <Section title="Up next">
            <Card pad={false}>
              {upNext.length === 0 ? (
                <EmptyState title="Nothing scheduled">Details you sign up for show here.</EmptyState>
              ) : (
                <RowList>
                  {upNext.map((d) => (
                    <li key={d.assignmentId}>
                      <JobRow
                        card={d.job}
                        now={now}
                        extra={
                          d.reason ? (
                            <>
                              <Chip tone="danger">{d.label}</Chip>
                              <span className="text-sm text-muted">{d.reason}</span>
                            </>
                          ) : undefined
                        }
                      />
                    </li>
                  ))}
                </RowList>
              )}
            </Card>
          </Section>
        </div>

        <div className="flex flex-col gap-4.5 md:gap-6">
          <Section
            title="Open for you"
            action={
              <Link href="/jobs?open=1" className="text-sm font-semibold">
                See all {data.open.length}
              </Link>
            }
          >
            <nav aria-label="Quick filters" className="flex flex-wrap gap-2">
              <Link href="/jobs?open=1&week=1" data-button-link className="inline-flex min-h-9 items-center rounded-full border border-line bg-surface px-3.5 text-sm font-medium text-ink no-underline hover:bg-subtle hover:text-ink pointer-coarse:min-h-11">
                This week
              </Link>
              <Link href="/jobs?open=1&flex=1" data-button-link className="inline-flex min-h-9 items-center rounded-full border border-line bg-surface px-3.5 text-sm font-medium text-ink no-underline hover:bg-subtle hover:text-ink pointer-coarse:min-h-11">
                Flexible times
              </Link>
              <Link href="/jobs?open=1&workable=1" data-button-link className="inline-flex min-h-9 items-center rounded-full border border-line bg-surface px-3.5 text-sm font-medium text-ink no-underline hover:bg-subtle hover:text-ink pointer-coarse:min-h-11">
                Only details I can work
              </Link>
            </nav>
            <Card pad={false}>
              {data.open.length === 0 ? (
                <EmptyState title="No open details">New details appear here when they are released.</EmptyState>
              ) : (
                <RowList>
                  {data.open.slice(0, 4).map((c) => (
                    <li key={c.id}>
                      <JobRow card={c} now={now} />
                    </li>
                  ))}
                </RowList>
              )}
            </Card>
          </Section>

          <Link href="/billing?tab=waiting" data-card-link className="group text-ink no-underline hover:text-ink">
            <Card className="flex-row items-center justify-between">
              <span className="flex flex-col gap-1">
                <span className="text-sm text-muted">Waiting on payment</span>
                <span className="text-stat font-bold" data-numeric>
                  {dollars(waitingTotal)}
                </span>
                <span className="text-sm text-muted">{waitingText(waiting.length, turns("vendor"), turns("deputy"), turns("coordinator"), waiting.filter((i) => i.status === "pending_review").length, waiting.filter((i) => i.status === "ready_to_send").length)}</span>
              </span>
              <span className="flex items-center gap-1 text-sm font-semibold text-link underline decoration-current/50 decoration-1 underline-offset-3 group-hover:decoration-current group-hover:decoration-2">
                Open
                <Icon name="chevronRight" size={18} />
              </span>
            </Card>
          </Link>
        </div>
      </div>
    </div>
  );
}
