import type { MessageDef } from "./catalog";
import { DETAIL_SECRETS, isLinkPlaceholder, isPlaceholder, PLACEHOLDERS, type PlaceholderKey, type PlaceholderValues } from "./placeholders";

/**
 * Rendering and checking an editable email message. The body is plain text: paragraphs are separated by a blank line,
 * and web addresses written in the message become links. Placeholder values are escaped and never become links,
 * except the link placeholders themselves, so a vendor name cannot add HTML or a link. A paragraph whose placeholders
 * are all empty is left out (an optional line such as the W-9 line or a reminder note).
 */

export type MessageText = { subject: string; body: string };
export type RenderedMessage = { subject: string; text: string; html: string };

const TOKEN = /\{\{([^{}]*)\}\}/g;
const URL = /\bhttps?:\/\/[^\s<>"']+[^\s<>"'.,;:!?)]/g;
const MAX_SUBJECT = 200;
const MAX_BODY = 10_000;

/** The placeholder names written in a text, in order, repeats included. */
export function placeholdersIn(text: string): string[] {
  return [...text.matchAll(TOKEN)].map((m) => m[1].trim());
}

function escapeHtml(s: string): string {
  return s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

/** Written text as HTML: escaped, with its own web addresses as links and line breaks kept. */
function literalHtml(s: string): string {
  let out = "";
  let last = 0;
  for (const m of s.matchAll(URL)) {
    out += escapeHtml(s.slice(last, m.index));
    out += `<a href="${escapeHtml(m[0])}">${escapeHtml(m[0])}</a>`;
    last = (m.index ?? 0) + m[0].length;
  }
  return (out + escapeHtml(s.slice(last))).replaceAll("\n", "<br>");
}

/** A value as HTML: escaped (no links), except a link placeholder's own address. */
function valueHtml(key: string, v: string): string {
  if (isPlaceholder(key) && isLinkPlaceholder(key) && /^https?:\/\//.test(v)) return `<a href="${escapeHtml(v)}">${escapeHtml(v)}</a>`;
  return escapeHtml(v).replaceAll("\n", "<br>");
}

const valueOf = (values: PlaceholderValues, raw: string) => {
  const key = raw.trim();
  return isPlaceholder(key) ? (values[key] ?? "") : "";
};
/** Spaces doubled by an empty value close up, and lines lose spaces at their ends. */
const tidy = (s: string) =>
  s
    .split("\n")
    .map((line) => line.replaceAll(/[ \t]{2,}/g, " ").trim())
    .join("\n")
    .trim();

/** One paragraph as text and HTML, or null when it has placeholders and every one of them is empty. */
function renderParagraph(p: string, values: PlaceholderValues): { text: string; html: string } | null {
  const keys = placeholdersIn(p);
  if (keys.length && keys.every((k) => !valueOf(values, k).trim())) return null;
  let text = "";
  let html = "";
  let last = 0;
  for (const m of p.matchAll(TOKEN)) {
    const lit = p.slice(last, m.index);
    const v = valueOf(values, m[1]);
    text += lit + v;
    html += literalHtml(lit) + valueHtml(m[1].trim(), v);
    last = (m.index ?? 0) + m[0].length;
  }
  text += p.slice(last);
  html += literalHtml(p.slice(last));
  return { text: tidy(text), html: tidy(html) };
}

/** The subject with its values: one line, whatever the values hold. */
function renderSubject(subject: string, values: PlaceholderValues): string {
  return tidy(subject.replaceAll(TOKEN, (_, k: string) => valueOf(values, k)).replaceAll(/[\r\n]+/g, " "));
}

/** The message with its values filled in, as a plain text body and a simple HTML body that say the same. */
export function renderMessage(m: MessageText, values: PlaceholderValues): RenderedMessage {
  const paragraphs = m.body
    .replaceAll("\r\n", "\n")
    .split(/\n[ \t]*\n/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => renderParagraph(p, values))
    .filter((p): p is { text: string; html: string } => p !== null && p.text !== "")
    // A value may carry its own paragraphs (one line per attached W-9).
    .flatMap((p) => {
      const texts = p.text.split(/\n{2,}/);
      const htmls = p.html.split(/(?:<br>){2,}/);
      return texts.length === htmls.length ? texts.map((t, i) => ({ text: t, html: htmls[i] })) : [p];
    });
  return { subject: renderSubject(m.subject, values), text: paragraphs.map((p) => p.text).join("\n\n"), html: paragraphs.map((p) => `<p>${p.html}</p>`).join("\n") };
}

/** Why an edited message cannot be saved, in plain words, or null. */
export function messageProblem(def: MessageDef, m: MessageText): string | null {
  const subject = m.subject.trim();
  const body = m.body.trim();
  if (!subject) return "Write a subject.";
  if (!body) return "Write the message.";
  if (subject.length > MAX_SUBJECT) return `Keep the subject to ${MAX_SUBJECT} characters.`;
  if (/[\r\n]/.test(subject)) return "Keep the subject on one line.";
  if (body.length > MAX_BODY) return `Keep the message to ${MAX_BODY.toLocaleString("en-US")} characters.`;
  const used = [...placeholdersIn(subject), ...placeholdersIn(body)];
  const allowed = new Set<string>(def.placeholders);
  if (def.confidential) {
    const secret = used.find((k) => (DETAIL_SECRETS as readonly string[]).includes(k));
    if (secret) return `A confidential detail's message can use only the date and time, not {{${secret}}}.`;
  }
  const unknown = used.find((k) => !allowed.has(k));
  if (unknown !== undefined) return `{{${unknown}}} is not a placeholder this message can use. Use the Insert placeholder buttons.`;
  const stray = (subject + body).replaceAll(TOKEN, "");
  if (stray.includes("{{") || stray.includes("}}")) return "A placeholder is missing a brace. Write it as {{name}}, or use the Insert placeholder buttons.";
  const missing = def.required?.find((r) => !used.includes(r.key));
  return missing ? missing.message : null;
}

/** The placeholders this message offers, with their labels. */
export function placeholderChoices(def: MessageDef): Array<{ key: PlaceholderKey; label: string }> {
  return def.placeholders.map((key) => ({ key, label: PLACEHOLDERS[key].label }));
}
