import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { and, eq } from "drizzle-orm";
import { withTx } from "@/ui/shell/request";
import { jobs, users } from "@/db/schema";
import { NotFoundError } from "@/domain/errors";
import { getMessage } from "@/domain/messages/messages";
import { ackStatusFor, ackTracking, dueDay, type AckTracking } from "@/domain/messages/acknowledgements";
import { Card } from "@/ui/components/Card";
import { Chip } from "@/ui/components/Chip";
import { Icon } from "@/ui/icons";
import { dateTime } from "../../_personnel/format";
import { personnelActor } from "../../_personnel/session";
import { MessageTools } from "./MessageTools";
import { AckPanel, RemindButton } from "./AckPanel";
import { confidentialVisible } from "@/domain/jobs/confidential";

export const metadata: Metadata = { title: "Message" };

/** "You sent this to 3 people" for the sender, "From Pat Lee" for everyone else. */
function fromLine(mine: boolean, recipients: number, sender: string): string {
  if (!mine) return `From ${sender}`;
  return `You sent this to ${recipients} ${recipients === 1 ? "person" : "people"}`;
}

/** One list of the tracking card: who acknowledged (with times) or who has not. */
function People({ title, rows }: Readonly<{ title: string; rows: Array<{ userId: string; name: string; at?: Date }> }>) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <h3 className="m-0 text-sm font-semibold">
        {title} <span className="font-normal text-muted" data-numeric>({rows.length})</span>
      </h3>
      {rows.length === 0 ? (
        <p className="m-0 text-sm text-muted">Nobody.</p>
      ) : (
        <ul className="m-0 flex list-none flex-col divide-y divide-divider p-0">
          {rows.map((r) => (
            <li key={r.userId} className="flex flex-wrap items-baseline justify-between gap-x-3 py-1.5 text-sm">
              <span>{r.name}</span>
              {r.at ? <span className="text-muted" data-numeric>{dateTime(r.at)}</span> : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Staff: acknowledged N of M, who has and who has not, Remind those who haven't, and the CSV. */
function AckTrackingCard({ t }: Readonly<{ t: AckTracking }>) {
  const overdue = t.dueAt !== null && t.dueAt.getTime() < Date.now() && t.pending.length > 0;
  return (
    <Card id="acknowledgements" aria-labelledby="ack-title" className="scroll-mt-24" data-testid="ack-tracking">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="ack-title" className="m-0 text-title font-semibold md:text-base">
          Acknowledged {t.acknowledged.length} of {t.total}
        </h2>
        {t.dueAt ? <Chip tone={overdue ? "danger" : "neutral"}>{overdue ? "Overdue" : "Due"} {dueDay(t.dueAt)}</Chip> : null}
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-sunken" aria-hidden>
        <div className="h-full bg-accent" style={{ width: `${Math.round((t.acknowledged.length / Math.max(1, t.total)) * 100)}%` }} />
      </div>
      {t.locksSignups ? <p className="m-0 text-sm text-muted">Sign-ups lock after the due date for anyone who has not acknowledged it.</p> : null}
      <div className="grid gap-4 md:grid-cols-2">
        <People title="Not acknowledged" rows={t.pending} />
        <People title="Acknowledged" rows={t.acknowledged} />
      </div>
      <div className="flex flex-wrap items-start gap-3 border-t border-divider pt-3">
        <RemindButton id={t.messageId} pending={t.pending.length} />
        <a href={`/api/v1/messages/${t.messageId}/acknowledgements?format=csv`} download className="inline-flex min-h-11 items-center gap-1 text-sm font-semibold">
          <Icon name="download" size={18} />
          Download CSV
        </a>
      </div>
      {t.remindedAt ? <p className="m-0 text-xs text-muted">Last reminded {dateTime(t.remindedAt)}.</p> : null}
    </Card>
  );
}

type Props = { params: Promise<{ id: string }> };

/** One message, for its sender or a recipient. Opening it marks it read. */
export default async function MessagePage({ params }: Readonly<Props>) {
  const actor = await personnelActor();
  const { id } = await params;
  const data = await withTx(async (tx) => {
    try {
      const m = await getMessage(actor, tx, id);
      const [sender] = m.senderUserId ? await tx.select({ name: users.name }).from(users).where(eq(users.id, m.senderUserId)) : [];
      // A confidential detail is named only to people who may see it.
      const [job] = m.jobId ? await tx.select({ id: jobs.id, number: jobs.number, title: jobs.title }).from(jobs).where(and(eq(jobs.id, m.jobId), confidentialVisible(tx, actor))) : [];
      const ack = m.requiresAck ? await ackStatusFor(actor, tx, m.id) : null;
      const staff = actor.role === "coordinator" || actor.role === "admin";
      const tracking = m.requiresAck && staff ? await ackTracking(actor, tx, m.id) : null;
      return { m, sender: sender?.name ?? "Signal 90", job, ack, tracking };
    } catch (e) {
      if (e instanceof NotFoundError) return null;
      throw e;
    }
  });
  if (!data) notFound();
  const { m } = data;
  const mine = m.senderUserId === actor.userId;
  return (
    <div className="mx-auto flex w-full max-w-200 flex-col gap-4.5">
      <Link href="/messages" className="inline-flex min-h-11 w-fit items-center gap-1 text-sm font-semibold">
        <Icon name="chevronLeft" size={18} />
        Back to messages
      </Link>
      <Card>
        <h1 className="m-0 text-2xl font-bold md:text-3xl">{m.subject}</h1>
        <p className="m-0 text-sm text-muted">
          {fromLine(mine, m.recipientCount, data.sender)}, {dateTime(m.sentAt)}
          {data.job ? (
            <>
              {". About "}
              <Link href={`/jobs/${data.job.number}`}>
                Detail #{data.job.number}, {data.job.title}
              </Link>
            </>
          ) : null}
          {m.replyToMessageId ? (
            <>
              {". "}
              <Link href={`/messages/${m.replyToMessageId}`}>In reply to an earlier message</Link>
            </>
          ) : null}
          .
        </p>
        <p className="m-0 max-w-[70ch] whitespace-pre-line">{m.body}</p>
        {data.ack ? (
          <AckPanel
            id={m.id}
            due={m.ackDueAt ? dueDay(m.ackDueAt) : null}
            acknowledgedText={data.ack.acknowledgedAt ? `You acknowledged this message ${dateTime(data.ack.acknowledgedAt)}.` : null}
          />
        ) : null}
        <MessageTools id={m.id} recipient={!mine} />
      </Card>
      {data.tracking ? <AckTrackingCard t={data.tracking} /> : null}
    </div>
  );
}
