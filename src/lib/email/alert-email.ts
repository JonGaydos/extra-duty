import { MESSAGES } from "@/domain/email-messages/catalog";
import { renderMessage } from "@/domain/email-messages/render";
import type { NotifyJobContent } from "@/domain/notifications/notify";
import type { OutgoingEmail } from "./types";

/**
 * The email for one queued alert, to the address on file at send time: the message rendered when it was queued. A job
 * queued before email messages were editable has none and gets the default alert message.
 */
export function alertEmail(to: string, c: NotifyJobContent, url: string | null): OutgoingEmail {
  const r = c.rendered ?? renderMessage(MESSAGES["job.changed"], { "alert.title": c.title, "alert.body": c.body, link: url ?? "" });
  return { to: [to], subject: r.subject, text: r.text, html: r.html };
}
