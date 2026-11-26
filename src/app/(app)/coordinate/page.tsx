import type { Metadata } from "next";
import { rateDollars } from "@/domain/jobs/rate";
import Link from "next/link";
import { withTx } from "@/ui/shell/request";
import { coordinatorTodo } from "@/domain/coordinator/views";
import { waitingText } from "@/domain/invoices/batch";
import { sendDayLabel } from "@/domain/invoices/send-schedule";
import { agencyDateParts } from "@/domain/time/agency-time";
import { ActionLink, ButtonLink } from "@/ui/components/Button";
import { Disclosure } from "@/ui/components/Disclosure";
import { Card } from "@/ui/components/Card";
import { Chip } from "@/ui/components/Chip";
import { EmptyState } from "@/ui/components/EmptyState";
import { dollars } from "@/ui/components/PayLabel";
import { Icon } from "@/ui/icons";
import { loadShell } from "@/ui/shell/load-shell";
import { clock, dateTime, dayLabel, hoursText, longDay, plural, prefixed, relativeDay, timeRange, whenText } from "../_personnel/format";
import { coordinatorActor } from "./_coordinator/session";
import { CountSection, Row, Rows } from "./_coordinator/ui";
import { ApproveInvoiceButton, FlagDecision, LiftLock, LockedCancel, NoteReview } from "./TodoActions";

export const metadata: Metadata = { title: "To-do" };

const LIST_LIMIT = 6;

function greeting(now: Date): string {
  const h = agencyDateParts(now).hour;
  if (h < 12) return "Good morning";
  return h < 17 ? "Good afternoon" : "Good evening";
}

const missingW9Text = (missing: Array<{ name: string }>) => (missing.length ? ` No W-9 on file: ${missing.map((m) => m.name).join(", ")}.` : "");

/** Rows past the first few fold into a disclosure, so a long list does not push the rest of the to-do down. */
function Capped<T>({ items, render }: Readonly<{ items: T[]; render: (item: T) => React.ReactNode }>) {
  const rest = items.slice(LIST_LIMIT);
  return (
    <>
      <Rows>{items.slice(0, LIST_LIMIT).map(render)}</Rows>
      {rest.length ? (
        <Disclosure label={`Show ${rest.length} more`} openLabel="Show fewer">
          <Rows>{rest.map(render)}</Rows>
        </Disclosure>
      ) : null}
    </>
  );
}

type Todo = Awaited<ReturnType<typeof coordinatorTodo>>;

/** Every item waiting on a coordinator; an open access review counts as one. */
function todoCount(t: Todo): number {
  return (
    (t.accessReview ? 1 : 0) +
    t.lockedStarted.length +
    t.lockedSoon.length +
    t.requests.length +
    t.changes.length +
    t.notes.length +
    t.flagRequests.length +
    t.missingContract.length +
    t.invoices.length +
    t.issues.length +
    t.opsOverdue.length +
    t.opsWaiting.length +
    t.unfilled.length +
    t.locks.length +
    t.ratesOutOfRange.length +
    t.sendInvoices.length +
    t.departed.length
  );
}

/** Locked details that have started: cancel each, with or without late cancellation pay. */
function LockedStartedSection({ t, now }: Readonly<{ t: Todo; now: Date }>) {
  if (t.lockedStarted.length === 0) return null;
  return (
    <CountSection title="Locked detail started: cancel" count={t.lockedStarted.length}>
      <Card tone="danger" pad={false} as="div" className="border-2">
        <ul className="m-0 list-none divide-y divide-danger-line p-0">
          {t.lockedStarted.map((j) => (
            <li key={j.jobId} className="flex flex-col gap-3 px-4 py-3.5 md:flex-row md:items-start md:justify-between">
              <div className="flex min-w-0 flex-col gap-1">
                <Link href={`/coordinate/details/${j.jobId}`} className="font-semibold text-danger-ink hover:text-danger-ink">
                  #{j.number} {j.title}, {j.vendorName}
                </Link>
                <p className="m-0 text-sm text-danger-ink">
                  {whenText(j.startAt, j.endAt, now)}. Vendor on payment hold since {dateTime(j.holdPlacedAt)}
                  {j.latePay
                    ? ` (within the late cancellation window): ${plural(j.signedUp, "person signed up gets", "people signed up get")} the late cancellation minimum.`
                    : ". The hold came earlier, so no pay unless you apply it."}
                </p>
              </div>
              <LockedCancel jobId={j.jobId} title={j.title} reason={`Vendor on payment hold: ${j.vendorName}`} latePay={j.latePay} signedUp={j.signedUp} />
            </li>
          ))}
        </ul>
      </Card>
    </CountSection>
  );
}

/** Vendor requests and change requests waiting for a decision. */
function RequestsSection({ t, now }: Readonly<{ t: Todo; now: Date }>) {
  if (t.requests.length === 0 && t.changes.length === 0) return null;
  return (
    <CountSection title="Vendor requests" count={t.requests.length + t.changes.length}>
      <Rows>
        {t.requests.map((r) => (
          <Row
            key={r.jobId}
            title={`${r.vendorName}: ${r.title}`}
            href={`/coordinate/details/${r.jobId}`}
            meta={
              <>
                {whenText(r.startAt, r.endAt, now)}
                {r.dates > 1 ? `, and ${plural(r.dates - 1, "more date")}` : ""}. {r.positions}.
                {r.flex ? ` Flexible ${timeRange(r.flex.earliestStartAt, r.flex.latestEndAt)}.` : ""}
                {r.locationName ? ` ${r.locationName}.` : ""}
              </>
            }
            actions={
              <ButtonLink href={`/coordinate/details/${r.jobId}`} size="sm" variant="secondary" aria-label={`Review request, ${r.title}`}>
                Review
              </ButtonLink>
            }
          />
        ))}
        {t.changes.map((c) => (
          <Row
            key={c.requestId}
            title={`${c.vendorName}: change to ${c.title}`}
            href={`/coordinate/details/${c.jobId}`}
            meta={`Asked ${dateTime(c.requestedAt)}`}
            actions={
              <ButtonLink href={`/coordinate/details/${c.jobId}`} size="sm" variant="secondary" aria-label={`Review change, ${c.title}`}>
                Review
              </ButtonLink>
            }
          />
        ))}
      </Rows>
    </CountSection>
  );
}

/** An open access review: how far along it is and when it is due. */
function AccessReviewSection({ review }: Readonly<{ review: NonNullable<Todo["accessReview"]> }>) {
  return (
    <CountSection title="Access review">
      <Card tone="warning">
        <p className="m-0 font-semibold text-warning-ink">
          {review.decided} of {review.total} accounts reviewed
        </p>
        <div className="h-2 overflow-hidden rounded-full bg-sunken" aria-hidden>
          <div className="h-full bg-accent" style={{ width: `${Math.round((review.decided / Math.max(1, review.total)) * 100)}%` }} />
        </div>
        <p className="m-0 text-sm text-warning-ink">Due {dateTime(review.dueAt)}. Keep, change or deactivate each account.</p>
        <ButtonLink href="/admin" variant="secondary" size="sm" className="w-fit">
          Continue review
        </ButtonLink>
      </Card>
    </CountSection>
  );
}

/**
 * The coordinator's to-do list: everything waiting on a coordinator, most urgent first. Sections with nothing in
 * them are left out.
 */
export default async function TodoPage() {
  const actor = await coordinatorActor();
  const shell = await loadShell();
  const now = new Date();
  const t = await withTx((tx) => coordinatorTodo(actor, tx, now));
  const first = shell?.profile.name.split(" ")[0] ?? "";
  const total = todoCount(t);

  return (
    <div className="flex flex-col gap-5.5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h1 className="m-0 text-2xl font-bold md:text-3xl">
            {greeting(now)}, {first}
          </h1>
          <p className="m-0 text-muted">
            {longDay(now)}. {total === 0 ? "Nothing needs you right now." : `${plural(total, "item needs", "items need")} you.`}
          </p>
        </div>
        <ButtonLink href="/coordinate/details/new">
          <Icon name="plus" size={20} />
          New detail
        </ButtonLink>
      </div>

      {total === 0 ? (
        <Card pad={false}>
          <EmptyState title="All caught up">New requests, invoices and issues show up here.</EmptyState>
        </Card>
      ) : null}

      {t.accessReview ? <AccessReviewSection review={t.accessReview} /> : null}

      <LockedStartedSection t={t} now={now} />

      {t.lockedSoon.length ? (
        <CountSection title="Locked, starting within 24 hours" count={t.lockedSoon.length}>
          <Rows tone="warning">
            {t.lockedSoon.map((j) => (
              <Row key={j.jobId} title={`#${j.number} ${j.vendorName}, ${relativeDay(j.startAt, now)} ${timeRange(j.startAt, j.endAt)}`} href={`/coordinate/details/${j.jobId}`} meta={`Vendor on payment hold. ${plural(j.signedUp, "person", "people")} signed up.`} />
            ))}
          </Rows>
        </CountSection>
      ) : null}

      <RequestsSection t={t} now={now} />

      {t.notes.length ? (
        <CountSection title="Deputy notes to review" count={t.notes.length}>
          <Rows>
            {t.notes.map((n) => (
              <Row key={n.id} title={`${n.vendorName}, ${n.locationName ?? "all locations"}, by ${n.authorName}`} meta={`Written ${dateTime(n.submittedAt)}. Never shown to the vendor.`} actions={<NoteReview noteId={n.id} body={n.body} />}>
                <p className="m-0 max-w-[70ch]">{n.body}</p>
              </Row>
            ))}
          </Rows>
        </CountSection>
      ) : null}

      {t.flagRequests.length ? (
        <CountSection title="Flag requests" count={t.flagRequests.length}>
          <Rows>
            {t.flagRequests.map((f) => (
              <Row key={f.id} title={`${f.userName}: ${f.qualificationName}`} meta={f.note ?? `Asked ${dateTime(f.requestedAt)}`} actions={<FlagDecision requestId={f.id} who={f.userName} />} />
            ))}
          </Rows>
        </CountSection>
      ) : null}

      {t.missingContract.length ? (
        <CountSection title="Details missing a contract" count={t.missingContract.length}>
          <Capped
            items={t.missingContract}
            render={(m) => (
              <Row key={m.jobId} title={`#${m.number} ${m.vendorName}, ${relativeDay(m.startAt, now)}`} href={`/coordinate/details/${m.jobId}`} meta={`${m.title}. No vendor contract and none on the detail.`} actions={<ButtonLink href={`/coordinate/vendors/${m.vendorId}#documents`} size="sm" variant="secondary" aria-label={`Add contract, ${m.vendorName}`}>Add contract</ButtonLink>} />
            )}
          />
        </CountSection>
      ) : null}

      {t.invoices.length ? (
        <CountSection title="Invoices to review" count={t.invoices.length}>
          <Rows>
            {t.invoices.map((i) => (
              <Row
                key={i.id}
                title={`${i.payeeName}, ${i.vendorName}, ${dollars(i.totalCents)}`}
                href={`/invoices/${i.id}`}
                meta={`${i.formattedNumber}, ${i.jobTitle}. Worked ${hoursText(i.workedMinutes, true)}, scheduled ${hoursText(i.scheduledMinutes, true)}.`}
                actions={
                  <>
                    <ApproveInvoiceButton invoiceId={i.id} batched={i.batched} sendByDefault={i.sendByDefault} />
                    <ButtonLink href={`/invoices/${i.id}`} size="sm" variant="secondary" aria-label={`Edit or send back, ${i.formattedNumber}`}>
                      Edit or send back
                    </ButtonLink>
                  </>
                }
              >
                {i.changeReason ? <p className="m-0 text-sm">Reason given: &ldquo;{i.changeReason}&rdquo;</p> : null}
              </Row>
            ))}
          </Rows>
        </CountSection>
      ) : null}

      {t.sendInvoices.length ? (
        <CountSection
          title="Send invoices"
          count={t.sendInvoices.length}
          action={
            <ActionLink href="/coordinate/send-invoices">All queued invoices</ActionLink>
          }
        >
          <Rows>
            {t.sendInvoices.map((b) => {
              const ready = b.invoices.filter((i) => !i.waiting).length;

              return (
                <Row
                  key={b.vendorId}
                  title={`${b.vendorName}, ${plural(ready, "invoice")}, ${dollars(b.totalCents)}`}
                  href={`/coordinate/send-invoices#vendor-${b.vendorId}`}
                  meta={`Due ${sendDayLabel(b.sendDay)}.${missingW9Text(b.missingW9)}`}
                  actions={
                    <ButtonLink href={`/coordinate/send-invoices#vendor-${b.vendorId}`} size="sm" aria-label={`Review and send, ${b.vendorName}`}>
                      Review and send
                    </ButtonLink>
                  }
                >
                  {b.waiting.map((w) => (
                    <p key={w.jobId} className="m-0 text-sm text-warning-ink">
                      #{w.jobNumber} {w.jobTitle}: {waitingText(w)}
                    </p>
                  ))}
                </Row>
              );
            })}
          </Rows>
        </CountSection>
      ) : null}

      {t.issues.length ? (
        <CountSection title="Payment issues with you" count={t.issues.length}>
          <Rows>
            {t.issues.map((i) => (
              <Row
                key={i.issueId}
                title={`${i.vendorName}, ${dollars(i.totalCents)}, for ${i.payeeName}`}
                href={`/invoices/${i.invoiceId}`}
                meta={i.number}
                actions={
                  <>
                    <Chip tone={i.day > i.limitDays ? "danger" : "coordinator"}>
                      Day {i.day} of {i.limitDays}
                      {i.day > i.limitDays ? ", overdue" : ""}
                    </Chip>
                    <ButtonLink href={`/invoices/${i.invoiceId}`} size="sm" variant="secondary" aria-label={`Work it, ${i.number}`}>
                      Work it
                    </ButtonLink>
                  </>
                }
              />
            ))}
          </Rows>
        </CountSection>
      ) : null}

      {t.opsOverdue.length || t.opsWaiting.length ? (
        <CountSection title="Ops plans" count={t.opsOverdue.length + t.opsWaiting.length} action={<ActionLink href="/coordinate/ops-plans">Ops plans and library</ActionLink>}>
          <Rows>
            {t.opsOverdue.map((o) => (
              <Row
                key={o.jobId}
                title={`${o.title}${prefixed(", IC ", o.icName)}`}
                href={`/coordinate/details/${o.jobId}#ops-plan`}
                meta={o.vendorName}
                actions={<Chip tone="danger">Overdue, due {o.dueAt ? dateTime(o.dueAt) : "before the start"}</Chip>}
              />
            ))}
            {t.opsWaiting.map((o) => (
              <Row
                key={o.jobId}
                title={`${o.title}, version ${o.version}`}
                href={`/coordinate/details/${o.jobId}#ops-plan`}
                meta={o.vendorName}
                actions={<Chip tone="warning">Waiting for the reviewer since {o.waitingSince ? dateTime(o.waitingSince) : ""}</Chip>}
              />
            ))}
          </Rows>
        </CountSection>
      ) : null}

      {t.unfilled.length ? (
        <CountSection title="Unfilled, starting within 72 hours" count={t.unfilled.length}>
          <Capped
            items={t.unfilled}
            render={(u) => <Row key={u.jobId} title={`${u.vendorName}, ${relativeDay(u.startAt, now)} ${clock(u.startAt, true)}`} href={`/coordinate/details/${u.jobId}`} meta={u.title} actions={<Chip tone="attention">{u.open} open</Chip>} />}
          />
        </CountSection>
      ) : null}

      {t.ratesOutOfRange.length ? (
        <CountSection title="Rates outside the agency range" count={t.ratesOutOfRange.length}>
          <Capped
            items={t.ratesOutOfRange}
            render={(r) => (
              <Row
                key={r.jobId}
                title={`${r.vendorName}, ${relativeDay(r.startAt, now)} ${clock(r.startAt, true)}`}
                href={`/coordinate/details/${r.jobId}`}
                meta={r.title}
                actions={<Chip tone="warning">{rateDollars(r.rateCents)} an hour</Chip>}
              />
            )}
          />
        </CountSection>
      ) : null}

      {t.departed.length ? (
        <CountSection title="Left the agency: not billed" count={t.departed.length}>
          <Rows tone="warning">
            {t.departed.map((d) => (
              <Row
                key={d.assignmentId}
                title={d.name}
                href={`/admin/users/${d.userId}`}
                meta={`#${d.jobNumber} ${d.vendorName}, ${dayLabel(d.startAt)}${d.lateCancel ? ". Late cancel pay" : ""}. Bill for them or write it off.`}
                actions={
                  <ButtonLink size="sm" variant="secondary" href={`/billing/bill/${d.assignmentId}`}>
                    Bill for them
                  </ButtonLink>
                }
              />
            ))}
          </Rows>
        </CountSection>
      ) : null}

      {t.locks.length ? (
        <CountSection title="Sign-up locks" count={t.locks.length}>
          <Rows>
            {t.locks.map((l) => (
              <Row
                key={l.userId}
                title={l.name}
                meta={[l.unbilled ? `${plural(l.unbilled, "unbilled detail")}` : "", l.unacknowledged ? `${plural(l.unacknowledged, "unconfirmed payment")}` : ""].filter(Boolean).join(", ")}
                actions={<LiftLock userId={l.userId} name={l.name} />}
              />
            ))}
          </Rows>
        </CountSection>
      ) : null}
    </div>
  );
}
