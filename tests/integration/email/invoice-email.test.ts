import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { useTestDb } from "../../setup/test-db";
import { useEmailQueue } from "../../setup/email-queue";
import { setupFixture } from "../assignments/helpers";
import { makeUser } from "../users/helpers";
import { assignments, invoices, notifications, users, vendors } from "@/db/schema";
import type { Actor } from "@/domain/actor";
import { createInvite } from "@/domain/auth/invites";
import { queueInvoiceEmail } from "@/domain/invoices/email";
import { createInvoice } from "@/domain/invoices/invoices";
import { updateSettings } from "@/domain/settings/settings";
import { readW9ForInvoiceEmail, uploadW9 } from "@/domain/w9/w9";
import { NotFoundError, ValidationError } from "@/domain/errors";
import { EMAIL_QUEUE, INVOICE_EMAIL_QUEUE, decodeEmailJob, getBoss, queueEmail, queueInvoiceJob, type EmailJob } from "@/jobs/boss";
import { handleInvoiceEmailJob } from "@/jobs/email-worker";
import { smtpSender } from "@/lib/email/adapters";
import { setEmailSender } from "@/lib/email/sender";
import { createMemorySender } from "@/lib/email/types";
import { byText } from "@/lib/sort";

// Fake email senders and transports are async to match the real ones; they answer at once.

const W9_PDF = Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.from("w9 form body ".repeat(20))]);
const GOOD_EMAIL = { provider: "smtp" as const, from: "Sheriff <no-reply@sheriff.example>", smtp: { host: "smtp.test" } };

describe("invoice email delivery", () => {
  const get = useTestDb();
  const { drain } = useEmailQueue(get);
  const mail = createMemorySender();
  let fx: Awaited<ReturnType<typeof setupFixture>>;
  let admin: Actor;

  beforeAll(async () => {
    const { db } = get();
    process.env.STORAGE_DRIVER = "local";
    process.env.STORAGE_LOCAL_DIR = await mkdtemp(join(tmpdir(), "extra-duty-email-"));
    fx = await setupFixture(db, "em");
    admin = (await makeUser(db, "admin", "em-admin@example.test")).actor;
    await db.update(vendors).set({ billingEmails: ["ap@vendor.example", "boss@vendor.example"] }).where(eq(vendors.id, fx.vendorId));
  });

  beforeEach(async () => {
    const { db } = get();
    mail.clear();
    setEmailSender(mail);
    await db.transaction((tx) =>
      updateSettings(admin, tx, { email: GOOD_EMAIL, billingReplyToEmail: "billing@sheriff.example", invoiceNumberPrefix: "ED-" }),
    );
    await drain();
  });

  async function mkInvoice(attachW9: boolean) {
    const { db } = get();
    const person = await fx.person();
    const { job, positionId } = await fx.mkJob();
    const [a] = await db.insert(assignments).values({ jobId: job.id, jobPositionId: positionId, userId: person.userId, status: "billed" }).returning();
    const inv = await db.transaction((tx) => createInvoice(tx, { assignmentId: a.id, minutes: 240, rateCents: 7000, status: "sent" }));
    await db.update(invoices).set({ attachW9 }).where(eq(invoices.id, inv.id));
    return { inv, job, person };
  }

  const status = async (id: string) => (await get().db.select().from(invoices).where(eq(invoices.id, id)))[0].emailStatus;
  const jobRows = async (queue: string) =>
    (await get().db.execute(sql`select state, retry_count as "retryCount" from pgboss.job where name = ${queue} order by created_on`)).rows as {
      state: string;
      retryCount: number;
    }[];

  test("a queued invoice email goes to the vendor billing emails with the PDF and the decrypted W-9", async () => {
    const { db } = get();
    const { inv, job, person } = await mkInvoice(true);
    await db.transaction((tx) => uploadW9(person, tx, W9_PDF, "w9.pdf"));
    await db.transaction((tx) => queueInvoiceEmail(tx, inv.id));
    expect(mail.sent).toHaveLength(0);
    expect(await status(inv.id)).toBe("queued");

    await drain();
    expect(mail.sent).toHaveLength(1);
    const msg = mail.sent[0];
    expect(msg.to).toEqual(["ap@vendor.example", "boss@vendor.example"]);
    expect(msg.replyTo).toBe("billing@sheriff.example");
    expect(msg.subject).toBe(`Invoice ED-${String(inv.number).padStart(6, "0")} for Detail #${job.number}`);
    const [pdf, w9] = msg.attachments!;
    expect(msg.attachments).toHaveLength(2);
    expect(pdf.filename).toBe(`ED-${String(inv.number).padStart(6, "0")}.pdf`);
    expect(pdf.content.subarray(0, 5).toString()).toBe("%PDF-");
    const payeeName = (await db.select().from(users).where(eq(users.id, person.userId)))[0].name;
    expect(w9.filename).toBe(`W-9 ${payeeName}.pdf`);
    expect(w9.content.equals(W9_PDF)).toBe(true);
    expect(await status(inv.id)).toBe("sent");

    // The system read of the W-9 is audited with no actor.
    const sysReads = await db.execute(sql`select 1 from audit_log where action = 'w9.read' and actor_user_id is null`);
    expect(sysReads.rows).toHaveLength(1);
  });

  test("readW9ForInvoiceEmail needs an invoice that attaches the W-9", async () => {
    const { db } = get();
    const off = await mkInvoice(false);
    await expect(db.transaction((tx) => readW9ForInvoiceEmail(tx, off.inv.id))).rejects.toBeInstanceOf(NotFoundError);
    const on = await mkInvoice(true);
    await expect(db.transaction((tx) => readW9ForInvoiceEmail(tx, on.inv.id))).rejects.toThrow("No W-9 on file.");
    await db.transaction((tx) => uploadW9(on.person, tx, W9_PDF, "w9.pdf"));
    const r = await db.transaction((tx) => readW9ForInvoiceEmail(tx, on.inv.id));
    expect(r.body.equals(W9_PDF)).toBe(true);
  });

  test("without attachW9 only the invoice PDF is attached", async () => {
    const { db } = get();
    const { inv } = await mkInvoice(false);
    await db.transaction((tx) => queueInvoiceEmail(tx, inv.id));
    await drain();
    expect(mail.sent[0].attachments).toHaveLength(1);
  });

  test("a send that keeps failing leaves the invoice queued while retrying, then fails and alerts", async () => {
    const { db } = get();
    const boss = await getBoss();
    await boss.updateQueue(INVOICE_EMAIL_QUEUE, { retryDelay: 0, retryBackoff: false });
    let attempts = 0;
    // The real SMTP adapter over a transport that throws.
    const down = {
      sendMail() {
        attempts++;
        return Promise.reject(new Error("smtp connect refused: 10.0.0.5 secret-host"));
      },
    };
    setEmailSender(smtpSender("a@b.test", { host: "x", port: 25, secure: false, user: "", password: "" }, down));
    const { inv, person } = await mkInvoice(false);
    await db.transaction((tx) => queueInvoiceEmail(tx, inv.id));

    // First attempt only.
    const [first] = await boss.fetch<{ invoiceId: string }>(INVOICE_EMAIL_QUEUE, { includeMetadata: true });
    await expect(handleInvoiceEmailJob(first)).rejects.toThrow("smtp connect refused");
    await boss.fail(INVOICE_EMAIL_QUEUE, first.id, { message: "x" });
    expect(await status(inv.id)).toBe("queued");
    expect((await jobRows(INVOICE_EMAIL_QUEUE)).at(-1)).toMatchObject({ state: "retry", retryCount: 0 });
    expect(await db.select().from(notifications).where(eq(notifications.type, "invoice.email_failed"))).toHaveLength(0);

    // The rest of the retries: 1 + 6 attempts in all, then failed.
    await drain();
    expect(attempts).toBe(7);
    expect((await jobRows(INVOICE_EMAIL_QUEUE)).at(-1)?.state).toBe("failed");
    expect(await status(inv.id)).toBe("failed");
    const alerts = await db.select().from(notifications).where(eq(notifications.type, "invoice.email_failed"));
    const staff = await db.select({ id: users.id }).from(users).where(sql`${users.role} in ('coordinator', 'admin') and ${users.active}`);
    expect(alerts.map((n) => n.userId).sort(byText)).toEqual([person.userId, ...staff.map((s) => s.id)].sort(byText));
    // Recipients get a plain summary; the detailed reason is only in the audit row.
    for (const n of alerts) expect(n.body).not.toContain("secret-host");
    const audit = await db.execute(sql`select after from audit_log where action = 'invoice.email_failed' and entity_id = ${inv.id}`);
    expect(JSON.stringify(audit.rows[0].after)).toContain("secret-host");
  });

  test("a payee with no W-9 on file fails at once, without retrying, and alerts", async () => {
    const { db } = get();
    let attempts = 0;
    setEmailSender({ send() { attempts++; return Promise.resolve(); } });
    const { inv } = await mkInvoice(true);
    await db.transaction((tx) => queueInvoiceEmail(tx, inv.id));
    await drain();
    expect(attempts).toBe(0);
    expect(await status(inv.id)).toBe("failed");
    expect(await db.select().from(notifications).where(sql`${notifications.type} = 'invoice.email_failed' and ${notifications.body} like '%No W-9%'`)).not.toHaveLength(0);
  });

  const staffIds = async () =>
    (await get().db.select({ id: users.id }).from(users).where(sql`${users.role} in ('coordinator', 'admin') and ${users.active}`)).map((s) => s.id);
  const unreadAlerts = async () =>
    (await get().db.select().from(notifications).where(sql`${notifications.type} = 'settings.email_incomplete' and ${notifications.readAt} is null`));

  test("an empty billing reply-to address fails fast with a settings message and alerts coordinators once", async () => {
    const { db } = get();
    await db.update(notifications).set({ readAt: new Date() });
    const { inv } = await mkInvoice(false);
    await db.transaction((tx) => updateSettings(fx.coord, tx, { billingReplyToEmail: "" }));
    const err = await db.transaction((tx) => queueInvoiceEmail(tx, inv.id)).catch((e) => e);
    expect(err).toBeInstanceOf(ValidationError);
    expect(err.message).toBe("Set the billing reply-to address in Settings before sending invoices.");
    expect((await jobRows(INVOICE_EMAIL_QUEUE)).filter((r) => r.state === "created")).toHaveLength(0);
    const staff = await staffIds();
    expect((await unreadAlerts()).map((n) => n.userId).sort(byText)).toEqual(staff.toSorted(byText));
    // Coordinators and admins can both set it, on the billing settings page.
    for (const n of await unreadAlerts()) {
      expect(n.link).toBe("/admin/settings/billing");
      expect(n.body).toBe("Set the billing reply-to address in Management, Settings, Billing and invoices before sending invoices.");
    }
    // A second failure does not stack another unread alert.
    await expect(db.transaction((tx) => queueInvoiceEmail(tx, inv.id))).rejects.toBeInstanceOf(ValidationError);
    expect(await unreadAlerts()).toHaveLength(staff.length);
  });

  test("an unconfigured provider fails fast, tells coordinators to ask an admin, and alerts them", async () => {
    const { db } = get();
    await db.update(notifications).set({ readAt: new Date() });
    const { inv } = await mkInvoice(false);
    await db.transaction((tx) => updateSettings(admin, tx, { email: { provider: "postmark", apiKeyEnc: "" } }));
    const msgText = "Ask an admin to set the email provider API key in Settings before sending invoices.";
    await expect(db.transaction((tx) => queueInvoiceEmail(tx, inv.id))).rejects.toThrow(msgText);
    const alerts = await unreadAlerts();
    expect(alerts.map((n) => n.userId).sort(byText)).toEqual((await staffIds()).sort(byText));
    // Admins go to the email server page; coordinators cannot open it, so they are sent to write to an admin.
    const roles = new Map((await get().db.select({ id: users.id, role: users.role }).from(users)).map((u) => [u.id, u.role]));
    for (const n of alerts) {
      if (roles.get(n.userId) === "admin") {
        expect(n.link).toBe("/admin/system/email");
        expect(n.body).toBe("Set the email provider API key in Management, System, Email before sending invoices.");
      } else {
        expect(n.link).toBe("/messages/new");
        expect(n.body).toBe("Ask an admin to set the email provider API key in Management, System, Email before sending invoices.");
      }
    }
    expect(alerts.some((n) => roles.get(n.userId) === "admin")).toBe(true);
    expect(alerts.some((n) => roles.get(n.userId) === "coordinator")).toBe(true);
    await db.transaction((tx) => updateSettings(admin, tx, { email: { provider: "smtp", from: "" } }));
    await expect(db.transaction((tx) => queueInvoiceEmail(tx, inv.id))).rejects.toThrow(
      "Ask an admin to set the sender address for outgoing email in Settings before sending invoices.",
    );
  });

  test("a second job for an already-sent invoice sends nothing", async () => {
    const { db } = get();
    const { inv } = await mkInvoice(false);
    await db.transaction((tx) => queueInvoiceEmail(tx, inv.id));
    await drain();
    expect(mail.sent).toHaveLength(1);
    await db.transaction((tx) => queueInvoiceJob(tx, inv.id));
    await drain();
    expect(mail.sent).toHaveLength(1);
  });

  test("a failed status write after a successful send does not make the queue send again", async () => {
    const { db } = get();
    const { inv } = await mkInvoice(false);
    await db.transaction((tx) => queueInvoiceEmail(tx, inv.id));
    // Block the sent write: a trigger that rejects updates to 'sent'.
    await db.execute(sql`create or replace function block_sent() returns trigger as $$ begin if new.email_status = 'sent' then raise exception 'blocked'; end if; return new; end $$ language plpgsql`);
    await db.execute(sql`create trigger block_sent_t before update on invoices for each row execute function block_sent()`);
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await drain();
    } finally {
      log.mockRestore();
      await db.execute(sql`drop trigger block_sent_t on invoices`);
    }
    expect(mail.sent).toHaveLength(1);
    expect((await jobRows(INVOICE_EMAIL_QUEUE)).at(-1)?.state).toBe("completed");
    expect(await status(inv.id)).toBe("queued");
  });
});

describe("queueEmail transaction", () => {
  const get = useTestDb();
  useEmailQueue(get);
  const count = async () => (await getBoss(), Number((await get().db.execute(sql`select count(*)::int as n from pgboss.job where name = ${EMAIL_QUEUE}`)).rows[0].n));
  const msg = (subject: string, text = "t") => ({ to: ["a@example.test"], subject, text, html: `<p>${text}</p>` });

  test("a rolled back transaction leaves no job; a committed one leaves exactly one", async () => {
    const { db } = get();
    const start = await count();
    await expect(
      db.transaction(async (tx) => {
        await queueEmail(tx, msg("rolled back"));
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(await count()).toBe(start);

    await db.transaction((tx) => queueEmail(tx, msg("committed")));
    expect(await count()).toBe(start + 1);
  });

  test("the job is not visible to the worker before commit", async () => {
    const { db } = get();
    const boss = await getBoss();
    for (const j of await boss.fetch(EMAIL_QUEUE, { batchSize: 100 })) await boss.complete(EMAIL_QUEUE, j.id);
    let seenInside = -1;
    await db.transaction(async (tx) => {
      await queueEmail(tx, msg("pending"));
      seenInside = (await boss.fetch(EMAIL_QUEUE, { batchSize: 10 })).length;
    });
    expect(seenInside).toBe(0);
    expect(await count()).toBeGreaterThan(0);
  });

  test("the stored payload holds no plaintext subject, body or link, and decodes back", async () => {
    const { db } = get();
    const token = "tok_SECRET_abcdef123456";
    await db.transaction((tx) => queueEmail(tx, msg("Set up your account", `https://app.test/accept-invite?token=${token}`)));
    const rows = (await db.execute(sql`select data::text as d from pgboss.job where name = ${EMAIL_QUEUE} order by created_on desc limit 1`)).rows as { d: string }[];
    expect(rows[0].d).not.toContain(token);
    expect(rows[0].d).not.toContain("accept-invite");
    expect(rows[0].d).not.toContain("Set up your account");
    const boss = await getBoss();
    const [job] = await boss.fetch<EmailJob>(EMAIL_QUEUE, { batchSize: 1000 }).then((js) => js.filter((j) => decodeEmailJob(j.data).subject === "Set up your account"));
    expect(decodeEmailJob(job.data).text).toContain(token);
  });

  test("an invite email job stores no raw token", async () => {
    const { db } = get();
    const coord = (await makeUser(db, "coordinator", "inv-coord@example.test")).actor;
    const { row } = await makeUser(db, "personnel", "inv-person@example.test");
    await db.transaction((tx) => createInvite(coord, tx, row.id));
    const all = (await db.execute(sql`select data::text as d from pgboss.job where name = ${EMAIL_QUEUE}`)).rows as { d: string }[];
    expect(all.every((r) => !r.d.includes("accept-invite") && !r.d.includes("inv-person@example.test"))).toBe(true);
  });

  test("attachments are refused", async () => {
    const { db } = get();
    await expect(
      db.transaction((tx) => queueEmail(tx, { ...msg("att"), attachments: [{ filename: "a.pdf", content: Buffer.from("x"), contentType: "application/pdf" }] })),
    ).rejects.toThrow("cannot carry attachments");
  });
});
