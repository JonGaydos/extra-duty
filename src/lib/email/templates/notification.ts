import { simpleEmail } from "../format";
import type { OutgoingEmail } from "../types";

export function notificationEmail(to: string, title: string, body: string, url: string | null): OutgoingEmail {
  return simpleEmail(to, title, [body, ...(url ? [`Open in Extra Duty: ${url}`] : [])].filter(Boolean));
}
