import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { eq } from "drizzle-orm";
import { withTx } from "@/ui/shell/request";
import { jobs, users } from "@/db/schema";
import { NotFoundError } from "@/domain/errors";
import { getMessage } from "@/domain/messages/messages";
import { Card } from "@/ui/components/Card";
import { Icon } from "@/ui/icons";
import { dateTime } from "../../_personnel/format";
import { personnelActor } from "../../_personnel/session";
import { MessageTools } from "./MessageTools";

export const metadata: Metadata = { title: "Message" };

type Props = { params: Promise<{ id: string }> };

/** One message, for its sender or a recipient. Opening it marks it read. */
export default async function MessagePage({ params }: Props) {
  const actor = await personnelActor();
  const { id } = await params;
  const data = await withTx(async (tx) => {
    try {
      const m = await getMessage(actor, tx, id);
      const [sender] = m.senderUserId ? await tx.select({ name: users.name }).from(users).where(eq(users.id, m.senderUserId)) : [];
      const [job] = m.jobId ? await tx.select({ id: jobs.id, number: jobs.number, title: jobs.title }).from(jobs).where(eq(jobs.id, m.jobId)) : [];
      return { m, sender: sender?.name ?? "Extra Duty", job };
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
          {mine ? `You sent this to ${m.recipientCount} ${m.recipientCount === 1 ? "person" : "people"}` : `From ${data.sender}`}, {dateTime(m.sentAt)}
          {data.job ? (
            <>
              {". About "}
              <Link href={`/jobs/${data.job.id}`}>
                job #{data.job.number} {data.job.title}
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
        <MessageTools id={m.id} recipient={!mine} />
      </Card>
    </div>
  );
}
