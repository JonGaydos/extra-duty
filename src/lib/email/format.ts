import type { OutgoingEmail } from "./types";

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/** A plain message built from paragraphs; the text and HTML bodies carry the same words. */
export function simpleEmail(to: string, subject: string, paragraphs: string[]): OutgoingEmail {
  return {
    to: [to],
    subject,
    text: paragraphs.join("\n\n"),
    html: paragraphs.map((p) => `<p>${escapeHtml(p)}</p>`).join("\n"),
  };
}
