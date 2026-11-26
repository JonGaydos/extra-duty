import type { OutgoingEmail } from "./types";

function escapeHtml(s: string): string {
  return s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
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
