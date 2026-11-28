import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { withTx } from "@/ui/shell/request";
import { isMessageKey, MESSAGES } from "@/domain/email-messages/catalog";
import { messageForEditor, previewValues } from "@/domain/email-messages/store";
import { NotFoundError } from "@/domain/errors";
import { PageTitle } from "../../../../../_personnel/TabLinks";
import { MessageEditor } from "../../../../_admin/MessageEditor";
import { managementActor } from "../../../../_admin/session";

type Props = { params: Promise<{ group: string; key: string }> };

const keyOf = async (params: Props["params"]) => {
  const p = await params;
  const key = decodeURIComponent(p.key);
  return p.group === "reminders" && isMessageKey(key) && !MESSAGES[key].hidden ? key : null;
};

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const key = await keyOf(params);
  return { title: key ? `Email: ${MESSAGES[key].label}` : "Email message" };
}

const CHANGED = new Intl.DateTimeFormat("en-US", { timeZone: "America/Chicago", dateStyle: "medium" });

/** One email message's editor, under Management, Reminders and locks, Email messages. */
export default async function EmailMessagePage({ params }: Readonly<Props>) {
  const actor = await managementActor();
  const key = await keyOf(params);
  if (!key) notFound();
  const data = await withTx(async (tx) => {
    try {
      return { ...(await messageForEditor(actor, tx, key)), samples: await previewValues(tx) };
    } catch (e) {
      if (e instanceof NotFoundError) return null;
      throw e;
    }
  });
  if (!data) notFound();
  const { def, current, editable, samples } = data;
  const changed = current.custom && current.changedAt ? `Changed by ${current.changedBy ?? "someone"} on ${CHANGED.format(current.changedAt)}.` : null;
  return (
    <div className="flex flex-col gap-4.5">
      <p className="m-0 text-sm">
        <Link href="/admin">Management</Link> / <Link href="/admin/settings/reminders#email-messages">Reminders and locks</Link>
      </p>
      <PageTitle sub={`To ${def.who.charAt(0).toLowerCase()}${def.who.slice(1)}. ${def.when}`}>{def.label}</PageTitle>
      <MessageEditor key={`${current.subject}\n${current.body}`} messageKey={key} def={def} initial={{ subject: current.subject, body: current.body }} custom={current.custom} changed={changed} editable={editable} samples={samples} />
    </div>
  );
}
