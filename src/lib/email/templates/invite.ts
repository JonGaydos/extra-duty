import { simpleEmail } from "../format";
import type { OutgoingEmail } from "../types";

export function inviteEmail(to: string, agencyName: string, link: string): OutgoingEmail {
  const msg = simpleEmail(to, "Set up your Signal 90 account", [
    `${agencyName} has created a Signal 90 account for you.`,
    "Use this link to set your password. It works once and expires in 7 days.",
    link,
    "After you set your password, each sign-in also needs a 6-digit code sent to this email address.",
  ]);
  return { ...msg, auth: true };
}
