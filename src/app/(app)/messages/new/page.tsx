import type { Metadata } from "next";
import Link from "next/link";
import { asc, eq } from "drizzle-orm";
import { withTx } from "@/ui/shell/request";
import { ranks, users } from "@/db/schema";
import { DomainError } from "@/domain/errors";
import { getMessage, linkableDetails } from "@/domain/messages/messages";
import { messageDirectory } from "@/domain/personnel/views";
import { getSettings } from "@/domain/settings/settings";
import { agencyDayKey } from "@/domain/time/agency-time";
import { Icon } from "@/ui/icons";
import { dayLabel } from "../../_personnel/format";
import { personnelActor } from "../../_personnel/session";
import { Compose } from "./Compose";

export const metadata: Metadata = { title: "New message" };

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

/**
 * Writing a message or a reply. `jobId` starts it addressed to that job's roster; `about` only picks the detail in
 * About a detail and leaves the recipients to the writer.
 */
export default async function NewMessagePage({ searchParams }: Readonly<Props>) {
  const actor = await personnelActor();
  const sp = await searchParams;
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? "";
  const now = new Date();
  const data = await withTx(async (tx) => {
    const people = (await messageDirectory(actor, tx)).filter((p) => p.id !== actor.userId);
    const rankRows = await tx.select({ id: ranks.id, name: ranks.name }).from(ranks).where(eq(ranks.active, true)).orderBy(asc(ranks.sortOrder));
    // Only details that have not ended: a deputy's own (signed up, pending or offered), any for staff.
    const linkable = await linkableDetails(actor, tx, now);
    const settings = await getSettings(tx);
    let reply = null;
    const replyTo = one(sp.replyTo);
    if (replyTo) {
      try {
        const m = await getMessage(actor, tx, replyTo);
        const [sender] = m.senderUserId ? await tx.select({ name: users.name }).from(users).where(eq(users.id, m.senderUserId)) : [];
        reply = { id: m.id, subject: m.subject, to: sender?.name ?? "the sender" };
      } catch (e) {
        if (!(e instanceof DomainError)) throw e;
      }
    }
    return {
      people: people.map((p) => ({ id: p.id, name: p.name })),
      ranks: rankRows,
      jobs: linkable.map((d) => ({ id: d.id, name: `#${d.number} ${d.vendorName}, ${dayLabel(d.startAt)}` })),
      canMessageAll: actor.role !== "personnel" || settings.personnelCanMessageAll,
      everyoneCount: people.length,
      reply,
    };
  });

  return (
    <div className="mx-auto flex w-full max-w-200 flex-col gap-4.5">
      <Link href="/messages" className="inline-flex min-h-11 w-fit items-center gap-1 text-sm font-semibold">
        <Icon name="chevronLeft" size={18} />
        Back to messages
      </Link>
      <h1 className="m-0 text-2xl font-bold md:text-3xl">{data.reply ? "Reply" : "New message"}</h1>
      <Compose people={data.people} ranks={data.ranks} jobs={data.jobs} canMessageAll={data.canMessageAll} everyoneCount={data.everyoneCount} initialJobId={one(sp.jobId)} initialAboutId={one(sp.about)} reply={data.reply} staff={actor.role === "coordinator" || actor.role === "admin"} today={agencyDayKey(now)} />
    </div>
  );
}
