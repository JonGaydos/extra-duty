import { createTransport } from "nodemailer";
import { describe, expect, test, vi } from "vitest";
import { mailgunSender, parseAddress, postmarkSender, sendgridSender, sesSender, smtpSender, type FetchLike } from "@/lib/email/adapters";
import { emailConfigProblem, REPLY_TO_PROBLEM, senderFromSettings, settingsProblemMessage } from "@/lib/email/provider";
import type { OutgoingEmail } from "@/lib/email/types";
import { encryptSecret } from "@/lib/crypto/secrets";

// Fake transports and fetches are async to match the real ones; they answer at once.

const PDF = Buffer.from("%PDF-1.4 invoice");
const W9 = Buffer.from("%PDF-1.4 w9");
const msg: OutgoingEmail = {
  to: ["ap@vendor.example", "boss@vendor.example"],
  replyTo: "billing@sheriff.example",
  subject: "Invoice ED-000123 for Detail #69344",
  text: "plain body",
  html: "<p>html body</p>",
  attachments: [
    { filename: "ED-000123.pdf", content: PDF, contentType: "application/pdf" },
    { filename: "W-9 Pat Doe.pdf", content: W9, contentType: "application/pdf" },
  ],
};
const FROM = "Sheriff <no-reply@sheriff.example>";

function mockFetch() {
  const calls: { url: string; init: RequestInit }[] = [];
  const impl: FetchLike = (url, init) => {
    calls.push({ url, init: init ?? {} });
    return Promise.resolve(new Response("{}", { status: 200 }));
  };
  return { calls, impl };
}

describe("email adapters", () => {
  test("smtp sends through the transport with reply-to and both attachments", async () => {
    const transport = createTransport({ jsonTransport: true });
    const sent: unknown[] = [];
    const spy = { sendMail: async (o: Record<string, unknown>) => (sent.push(await transport.sendMail(o)), undefined) };
    await smtpSender(FROM, { host: "x", port: 587, secure: false, user: "", password: "" }, spy).send(msg);
    const json = JSON.parse((sent[0] as { message: string }).message);
    expect(json.from).toEqual({ address: "no-reply@sheriff.example", name: "Sheriff" });
    expect(json.to.map((t: { address: string }) => t.address)).toEqual(msg.to);
    expect(json.replyTo[0].address).toBe("billing@sheriff.example");
    expect(json.subject).toBe(msg.subject);
    expect(json.text).toBe("plain body");
    expect(json.html).toBe("<p>html body</p>");
    expect(json.attachments.map((a: { filename: string }) => a.filename)).toEqual(["ED-000123.pdf", "W-9 Pat Doe.pdf"]);
    expect(Buffer.from(json.attachments[1].content, "base64").equals(W9)).toBe(true);
  });

  test("postmark posts JSON with the server token", async () => {
    const f = mockFetch();
    await postmarkSender(FROM, "pm-key", f.impl).send(msg);
    expect(f.calls[0].url).toBe("https://api.postmarkapp.com/email");
    expect((f.calls[0].init.headers as Record<string, string>)["X-Postmark-Server-Token"]).toBe("pm-key");
    const body = JSON.parse(f.calls[0].init.body as string);
    expect(body).toMatchObject({ From: FROM, To: "ap@vendor.example,boss@vendor.example", ReplyTo: "billing@sheriff.example", Subject: msg.subject, TextBody: "plain body", HtmlBody: "<p>html body</p>" });
    expect(body.Attachments).toEqual([
      { Name: "ED-000123.pdf", Content: PDF.toString("base64"), ContentType: "application/pdf" },
      { Name: "W-9 Pat Doe.pdf", Content: W9.toString("base64"), ContentType: "application/pdf" },
    ]);
  });

  test("sendgrid posts JSON with a bearer key", async () => {
    const f = mockFetch();
    await sendgridSender(FROM, "sg-key", f.impl).send(msg);
    expect(f.calls[0].url).toBe("https://api.sendgrid.com/v3/mail/send");
    expect((f.calls[0].init.headers as Record<string, string>).Authorization).toBe("Bearer sg-key");
    const body = JSON.parse(f.calls[0].init.body as string);
    expect(body.personalizations[0].to).toEqual([{ email: "ap@vendor.example" }, { email: "boss@vendor.example" }]);
    expect(body.from).toEqual({ email: "no-reply@sheriff.example", name: "Sheriff" });
    expect(body.reply_to).toEqual({ email: "billing@sheriff.example" });
    expect(body.subject).toBe(msg.subject);
    expect(body.content.map((c: { type: string }) => c.type)).toEqual(["text/plain", "text/html"]);
    expect(body.attachments.map((a: { filename: string }) => a.filename)).toEqual(["ED-000123.pdf", "W-9 Pat Doe.pdf"]);
    expect(body.attachments[0].content).toBe(PDF.toString("base64"));
  });

  test("mailgun posts a form to the sender domain with basic auth", async () => {
    const f = mockFetch();
    await mailgunSender(FROM, "mg-key", "", f.impl).send(msg);
    expect(f.calls[0].url).toBe("https://api.mailgun.net/v3/sheriff.example/messages");
    expect((f.calls[0].init.headers as Record<string, string>).Authorization).toBe(`Basic ${Buffer.from("api:mg-key").toString("base64")}`);
    const form = f.calls[0].init.body as FormData;
    expect(form.getAll("to")).toEqual(msg.to);
    expect(form.get("h:Reply-To")).toBe("billing@sheriff.example");
    expect(form.get("subject")).toBe(msg.subject);
    expect(form.get("text")).toBe("plain body");
    expect(form.get("html")).toBe("<p>html body</p>");
    const files = form.getAll("attachment") as File[];
    expect(files.map((a) => a.name)).toEqual(["ED-000123.pdf", "W-9 Pat Doe.pdf"]);
    expect(Buffer.from(await files[1].arrayBuffer()).equals(W9)).toBe(true);
    const eu = mockFetch();
    await mailgunSender(FROM, "k", "EU", eu.impl).send(msg);
    expect(eu.calls[0].url).toBe("https://api.eu.mailgun.net/v3/sheriff.example/messages");
  });

  test("ses sends one raw message carrying reply-to and both attachments", async () => {
    const send = vi.fn(() => Promise.resolve({ MessageId: "1" }));
    await sesSender(FROM, "AKIA:secret", "us-east-2", { send }).send(msg);
    expect(send).toHaveBeenCalledTimes(1);
    const input = (send.mock.calls[0] as unknown as [{ input: { Content: { Raw: { Data: Uint8Array } } } }])[0].input;
    const raw = Buffer.from(input.Content.Raw.Data).toString("utf8");
    expect(raw).toContain("Reply-To: billing@sheriff.example");
    expect(raw).toContain("Subject: Invoice ED-000123 for Detail #69344");
    expect(raw).toContain("filename=ED-000123.pdf");
    expect(raw).toContain('filename="W-9 Pat Doe.pdf"');
    expect(raw).toContain(W9.toString("base64"));
  });

  test("an smtp transport that throws surfaces its error from send", async () => {
    const down = { sendMail: () => Promise.reject(new Error("connect ECONNREFUSED")) };
    await expect(smtpSender(FROM, { host: "x", port: 587, secure: false, user: "", password: "" }, down).send(msg)).rejects.toThrow("connect ECONNREFUSED");
  });

  test("an HTTP error becomes an error naming the provider", async () => {
    const impl: FetchLike = () => Promise.resolve(new Response("bad key", { status: 401 }));
    await expect(postmarkSender(FROM, "k", impl).send(msg)).rejects.toThrow("Postmark rejected the message (HTTP 401): bad key");
  });

  test("parseAddress handles bare and named addresses", () => {
    expect(parseAddress("a@b.test")).toEqual({ name: "", email: "a@b.test" });
    expect(parseAddress('"Sheriff Office" <a@b.test>')).toEqual({ name: "Sheriff Office", email: "a@b.test" });
  });
});

describe("provider selection", () => {
  const base = { provider: "smtp" as const, from: "a@b.test", smtp: { host: "h", port: 25, secure: false, user: "", passwordEnc: "" }, apiKeyEnc: "", region: "" };

  test("incomplete settings give a problem code, whether only an admin can fix it, and one message", () => {
    expect(emailConfigProblem({ ...base, from: " " })).toMatchObject({ code: "from_missing", adminOnly: true });
    expect(emailConfigProblem({ ...base, smtp: { ...base.smtp, host: "" } })).toMatchObject({ code: "smtp_host_missing" });
    expect(emailConfigProblem({ ...base, provider: "sendgrid" })).toMatchObject({ code: "api_key_missing" });
    const ses = { ...base, provider: "ses" as const, apiKeyEnc: encryptSecret("AKIA:secret") };
    expect(emailConfigProblem(ses)).toMatchObject({ code: "region_missing" });
    expect(emailConfigProblem({ ...ses, region: "us-east-1" })).toBeNull();
    const bad = emailConfigProblem({ ...ses, region: "us-east-1", apiKeyEnc: encryptSecret("no-colon-here") });
    expect(bad).toMatchObject({ code: "api_key_invalid" });
    expect(settingsProblemMessage(bad!, "sending invoices")).toBe(
      "Ask an admin to set the email provider API key in the form ACCESS_KEY_ID:SECRET_ACCESS_KEY in Settings before sending invoices.",
    );
    expect(settingsProblemMessage(REPLY_TO_PROBLEM, "sending invoices")).toBe("Set the billing reply-to address in Settings before sending invoices.");
    expect(emailConfigProblem(base)).toBeNull();
  });

  test("each provider builds a sender; incomplete settings throw", () => {
    const key = encryptSecret("k");
    for (const provider of ["smtp", "postmark", "sendgrid", "mailgun"] as const) {
      expect(senderFromSettings({ ...base, provider, apiKeyEnc: key })).toHaveProperty("send");
    }
    expect(senderFromSettings({ ...base, provider: "ses", apiKeyEnc: encryptSecret("AKIA:secret"), region: "us-east-1" })).toHaveProperty("send");
    expect(() => senderFromSettings({ ...base, provider: "mailgun" })).toThrow("Ask an admin to set the email provider API key in Settings before sending email.");
  });
});
