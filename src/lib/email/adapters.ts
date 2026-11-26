import { SendEmailCommand, SESv2Client } from "@aws-sdk/client-sesv2";
import { createTransport } from "nodemailer";
import type { EmailSender, OutgoingEmail } from "./types";

/** Anything with Nodemailer's sendMail, so tests can pass a jsonTransport or a failing stub. */
export type MailTransport = { sendMail(options: Record<string, unknown>): Promise<unknown> };
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export type SmtpConfig = { host: string; port: number; secure: boolean; user: string; password: string };

/** Splits `Name <addr@host>` or a bare address. */
export function parseAddress(from: string): { name: string; email: string } {
  const t = from.trimEnd();
  const lt = t.lastIndexOf("<");
  const inner = t.slice(lt + 1, -1);
  const name = t.slice(0, Math.max(lt, 0)).trim();
  // Scanned with indexOf and plain checks, not one regex, so a long input cannot make it slow.
  if (t.endsWith(">") && lt !== -1 && inner !== "" && !inner.includes(">") && !/[\n\r\u2028\u2029]/.test(name)) {
    return { name: name.replace(/^"|"$/g, ""), email: inner.trim() };
  }
  return { name: "", email: from.trim() };
}

function mailOptions(from: string, msg: OutgoingEmail): Record<string, unknown> {
  return {
    from,
    to: msg.to,
    replyTo: msg.replyTo,
    subject: msg.subject,
    text: msg.text,
    html: msg.html,
    attachments: msg.attachments?.map((a) => ({ filename: a.filename, content: a.content, contentType: a.contentType })),
  };
}

export function smtpSender(from: string, cfg: SmtpConfig, transport?: MailTransport): EmailSender {
  const t: MailTransport =
    transport ??
    createTransport({
      host: cfg.host,
      port: cfg.port,
      secure: cfg.secure,
      auth: cfg.user ? { user: cfg.user, pass: cfg.password } : undefined,
    });
  return {
    async send(msg) {
      await t.sendMail(mailOptions(from, msg));
    },
  };
}

async function postJson(fetchImpl: FetchLike, provider: string, url: string, init: RequestInit): Promise<void> {
  const res = await fetchImpl(url, init);
  if (!res.ok) {
    const body = (await res.text().catch(() => "")).slice(0, 300);
    throw new Error(`${provider} rejected the message (HTTP ${res.status}): ${body}`);
  }
}

const b64 = (b: Buffer) => b.toString("base64");

export function postmarkSender(from: string, apiKey: string, fetchImpl: FetchLike = fetch): EmailSender {
  return {
    async send(msg) {
      await postJson(fetchImpl, "Postmark", "https://api.postmarkapp.com/email", {
        method: "POST",
        headers: { "X-Postmark-Server-Token": apiKey, "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({
          From: from,
          To: msg.to.join(","),
          ReplyTo: msg.replyTo,
          Subject: msg.subject,
          TextBody: msg.text,
          HtmlBody: msg.html,
          Attachments: msg.attachments?.map((a) => ({ Name: a.filename, Content: b64(a.content), ContentType: a.contentType })),
        }),
      });
    },
  };
}

export function sendgridSender(from: string, apiKey: string, fetchImpl: FetchLike = fetch): EmailSender {
  const sender = parseAddress(from);
  return {
    async send(msg) {
      await postJson(fetchImpl, "SendGrid", "https://api.sendgrid.com/v3/mail/send", {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          personalizations: [{ to: msg.to.map((email) => ({ email })) }],
          from: sender.name ? { email: sender.email, name: sender.name } : { email: sender.email },
          reply_to: msg.replyTo ? { email: msg.replyTo } : undefined,
          subject: msg.subject,
          content: [
            { type: "text/plain", value: msg.text },
            { type: "text/html", value: msg.html },
          ],
          attachments: msg.attachments?.map((a) => ({ content: b64(a.content), filename: a.filename, type: a.contentType, disposition: "attachment" })),
        }),
      });
    },
  };
}

/** The sending domain is the domain of the From address. `region` "eu" uses Mailgun's EU endpoint. */
export function mailgunSender(from: string, apiKey: string, region: string, fetchImpl: FetchLike = fetch): EmailSender {
  const domain = parseAddress(from).email.split("@")[1] ?? "";
  const host = region.trim().toLowerCase() === "eu" ? "api.eu.mailgun.net" : "api.mailgun.net";
  return {
    async send(msg) {
      const form = new FormData();
      form.set("from", from);
      for (const to of msg.to) form.append("to", to);
      if (msg.replyTo) form.set("h:Reply-To", msg.replyTo);
      form.set("subject", msg.subject);
      form.set("text", msg.text);
      form.set("html", msg.html);
      for (const a of msg.attachments ?? []) {
        form.append("attachment", new Blob([new Uint8Array(a.content)], { type: a.contentType }), a.filename);
      }
      const basic = Buffer.from(`api:${apiKey}`).toString("base64");
      await postJson(fetchImpl, "Mailgun", `https://${host}/v3/${encodeURIComponent(domain)}/messages`, {
        method: "POST",
        headers: { Authorization: `Basic ${basic}` },
        body: form,
      });
    },
  };
}

type SesClientLike = { send(command: unknown): Promise<unknown> };

/** `credentials` is "ACCESS_KEY_ID:SECRET_ACCESS_KEY". The raw MIME message carries the attachments. */
export function sesSender(from: string, credentials: string, region: string, client?: SesClientLike): EmailSender {
  const sep = credentials.indexOf(":");
  const sesClient =
    client ??
    new SESv2Client({
      region,
      credentials: { accessKeyId: credentials.slice(0, sep), secretAccessKey: credentials.slice(sep + 1) },
    });
  const transport = createTransport({ SES: { sesClient: sesClient as never, SendEmailCommand } });
  return {
    async send(msg) {
      await transport.sendMail(mailOptions(from, msg));
    },
  };
}
