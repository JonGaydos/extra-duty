import { simpleEmail } from "../format";
import type { OutgoingEmail } from "../types";

export function inviteEmail(to: string, agencyName: string, link: string): OutgoingEmail {
  const msg = simpleEmail(to, "Set up your Extra Duty account", [
    `${agencyName} has created an Extra Duty account for you.`,
    "Use this link to set your password. It works once and expires in 7 days.",
    link,
    "After you set your password, each sign-in also needs a 6-digit code sent to this email address.",
  ]);
  return { ...msg, auth: true };
}
