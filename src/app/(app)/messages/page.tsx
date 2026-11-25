import type { Metadata } from "next";
import { inArray } from "drizzle-orm";
import { withTx } from "@/ui/shell/request";
import { jobs } from "@/db/schema";
import { listInbox, listSent, unreadMessageCount } from "@/domain/messages/messages";
import { agencyDayKey } from "@/domain/time/agency-time";
import { initialsOf } from "@/domain/users/profile";
import { ButtonLink } from "@/ui/components/Button";
import { Card } from "@/ui/components/Card";
import { EmptyState } from "@/ui/components/EmptyState";
import { Input } from "@/ui/components/FormField";
import { clock, monthDay } from "../_personnel/format";
import { personnelActor } from "../_personnel/session";
import { PageTitle, TabLinks } from "../_personnel/TabLinks";
import { MessageList, type MessageRowView } from "./MessageList";

export const metadata: Metadata = { title: "Messages" };

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

function when(d: Date, now: Date): string {
  if (agencyDayKey(d) === agencyDayKey(now)) return clock(d);
  if (agencyDayKey(d) === agencyDayKey(new Date(now.getTime() - 86_400_000))) return "Yesterday";
  return monthDay(d);
}

/** Message Center: Inbox and Sent, a filter, and mark read, unread or delete. */
export default async function MessagesPage({ searchParams }: Props) {
  const actor = await personnelActor();
  const sp = await searchParams;
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? "";
  const tab = one(sp.tab) === "sent" ? "sent" : "inbox";
  const q = one(sp.q).slice(0, 200);
  const unreadOnly = one(sp.unread) === "1";
  const now = new Date();
  const data = await withTx(async (tx) => {
    const inbox = tab === "inbox" ? await listInbox(actor, tx, { text: q, unreadOnly, page: 1 }) : [];
    const sent = tab === "sent" ? await listSent(actor, tx, { page: 1 }) : [];
    const unread = await unreadMessageCount(actor, tx);
    const jobIds = [...new Set([...inbox, ...sent].map((m) => m.jobId).filter((v): v is string => v !== null))];
    const numbers = jobIds.length ? await tx.select({ id: jobs.id, number: jobs.number }).from(jobs).where(inArray(jobs.id, jobIds)) : [];
    return { inbox, sent, unread, numbers: new Map(numbers.map((n) => [n.id, n.number])) };
  });
  const tag = (jobId: string | null) => (jobId && data.numbers.has(jobId) ? `Job #${data.numbers.get(jobId)}` : null);
  const rows: MessageRowView[] =
    tab === "inbox"
      ? data.inbox.map((m) => ({ id: m.messageId, who: m.senderName ?? "Extra Duty", initials: initialsOf(m.senderName ?? "Extra Duty"), when: when(m.sentAt, now), subject: m.subject, snippet: m.snippet, unread: !m.read, tag: tag(m.jobId) }))
      : data.sent.map((m) => ({ id: m.messageId, who: `To ${m.recipientCount} ${m.recipientCount === 1 ? "person" : "people"}`, initials: "To", when: when(m.sentAt, now), subject: m.subject, snippet: m.snippet, unread: false, tag: tag(m.jobId) }));

  return (
    <div className="mx-auto flex w-full max-w-200 flex-col gap-4.5">
      <PageTitle action={<ButtonLink href="/messages/new">New message</ButtonLink>}>Messages</PageTitle>
      <TabLinks
        label="Message folders"
        current={tab}
        items={[
          { key: "inbox", label: data.unread ? `Inbox (${data.unread} new)` : "Inbox", href: "/messages" },
          { key: "sent", label: "Sent", href: "/messages?tab=sent" },
        ]}
      />
      {tab === "inbox" ? (
        <form role="search" className="flex flex-wrap items-center gap-3" action="/messages">
          <Input type="search" name="q" defaultValue={q} aria-label="Filter messages" placeholder="Filter messages" className="min-w-0 flex-1" />
          <label className="flex min-h-11 items-center gap-2 text-sm">
            <input type="checkbox" name="unread" value="1" defaultChecked={unreadOnly} className="size-4.5 accent-accent" />
            Unread only
          </label>
          <button type="submit" className="inline-flex h-11 items-center rounded-md border border-line bg-surface px-4 font-semibold text-ink hover:bg-subtle">
            Filter
          </button>
        </form>
      ) : null}
      {rows.length === 0 ? (
        <Card pad={false}>
          <EmptyState title={tab === "inbox" ? (q || unreadOnly ? "No messages match" : "No messages yet") : "Nothing sent yet"}>
            {tab === "inbox" ? "Messages from coordinators and other deputies show here." : "Messages you send show here."}
          </EmptyState>
        </Card>
      ) : (
        <MessageList rows={rows} selectable={tab === "inbox"} />
      )}
    </div>
  );
}
