import { beforeEach, describe, expect, test } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { useTestDb } from "../../setup/test-db";
import { useEmailQueue } from "../../setup/email-queue";
import { makeUser } from "../users/helpers";
import { auditLog, emailMessages, users } from "@/db/schema";
import { createInvite } from "@/domain/auth/invites";
import { listMessages, loadMessage, messageForEditor, resetMessage, saveMessage, sendTestMessage } from "@/domain/email-messages/store";
import { ForbiddenError, NotFoundError, ValidationError } from "@/domain/errors";
import { emit } from "@/domain/notifications/notify";
import { seed } from "@/db/seed";
import { EMAIL_QUEUE, NOTIFY_EMAIL_QUEUE } from "@/jobs/boss";
import { setEmailSender } from "@/lib/email/sender";
import { createMemorySender } from "@/lib/email/types";

describe("editable email messages", () => {
  const get = useTestDb();
  const { drain, drainNotifications } = useEmailQueue(get);
  const mail = createMemorySender();
  let n = 0;
  const person = (role: "admin" | "coordinator" | "personnel") => makeUser(get().db, role, `em${++n}@example.test`);
  const run = <T>(fn: (tx: Parameters<Parameters<ReturnType<typeof get>["db"]["transaction"]>[0]>[0]) => Promise<T>) => get().db.transaction(fn);

  beforeEach(async () => {
    mail.clear();
    setEmailSender(mail);
    await seed(get().db);
    await get().db.delete(emailMessages);
    await get().db.execute(sql`delete from pgboss.job where name in (${NOTIFY_EMAIL_QUEUE}, ${EMAIL_QUEUE})`);
  });

  test("a saved message is used for the next email, and reset puts the default back; both are audited with before and after", async () => {
    const coord = await person("coordinator");
    const deputy = await person("personnel");
    await get().db.update(users).set({ name: "Jordan Example" }).where(eq(users.id, deputy.row.id));
    const saved = await run((tx) => saveMessage(coord.actor, tx, "job.changed", { subject: "Heads up: {{alert.title}}", body: "Hi {{person.firstName}},\n\n{{alert.body}}\n\n{{link}}" }));
    expect(saved).toMatchObject({ custom: true, subject: "Heads up: {{alert.title}}" });

    await run((tx) => emit(tx, { type: "job.changed", recipients: [deputy.row.id], title: "Detail changed", body: "The start time moved.", link: "/jobs/abc" }));
    await drainNotifications();
    expect(mail.sent[0]).toMatchObject({ subject: "Heads up: Detail changed", text: "Hi Jordan,\n\nThe start time moved.\n\nhttp://localhost:3000/jobs/abc" });
    expect(mail.sent[0].html).toContain('<a href="http://localhost:3000/jobs/abc">');

    const audit = await get().db.select().from(auditLog).where(and(eq(auditLog.action, "email_message.update"), eq(auditLog.entityId, "job.changed")));
    expect(audit).toHaveLength(1);
    expect(audit[0].before).toMatchObject({ subject: "{{alert.title}}", custom: false });
    expect(audit[0].after).toMatchObject({ subject: "Heads up: {{alert.title}}", custom: true });

    const back = await run((tx) => resetMessage(coord.actor, tx, "job.changed"));
    expect(back).toMatchObject({ custom: false, subject: "{{alert.title}}" });
    const resetAudit = await get().db.select().from(auditLog).where(and(eq(auditLog.action, "email_message.reset"), eq(auditLog.entityId, "job.changed")));
    expect(resetAudit[0].before).toMatchObject({ subject: "Heads up: {{alert.title}}" });
    expect(resetAudit[0].after).toMatchObject({ subject: "{{alert.title}}", custom: false });
  });

  test("the editor shows who changed it", async () => {
    const coord = await person("coordinator");
    await get().db.update(users).set({ name: "Dana Coord" }).where(eq(users.id, coord.row.id));
    await run((tx) => saveMessage(coord.actor, tx, "job.reminder", { subject: "Soon: #{{detail.number}}", body: "{{detail.date}}" }));
    const { current, editable } = await run((tx) => messageForEditor(coord.actor, tx, "job.reminder"));
    expect(current).toMatchObject({ custom: true, changedBy: "Dana Coord" });
    expect(current.changedAt).toBeInstanceOf(Date);
    expect(editable).toBe(true);
  });

  test("required placeholders, unknown placeholders and confidential limits are refused on save", async () => {
    const admin = await person("admin");
    await expect(run((tx) => saveMessage(admin.actor, tx, "auth.sign_in_code", { subject: "Code", body: "Hello." }))).rejects.toThrow("The sign-in code must stay in this message.");
    await expect(run((tx) => saveMessage(admin.actor, tx, "job.reminder", { subject: "x", body: "{{code}}" }))).rejects.toBeInstanceOf(ValidationError);
    await expect(run((tx) => saveMessage(admin.actor, tx, "job.reminder.confidential", { subject: "x", body: "{{detail.title}}" }))).rejects.toThrow(/only the date and time/);
    await expect(run((tx) => saveMessage(admin.actor, tx, "nope", { subject: "x", body: "y" }))).rejects.toBeInstanceOf(NotFoundError);
    expect((await run((tx) => loadMessage(tx, "auth.sign_in_code"))).custom).toBe(false);
  });

  test("sign-in, invite, password reset and security emails are admins' only; an admin's edit reaches the invite", async () => {
    const coord = await person("coordinator");
    const admin = await person("admin");
    for (const key of ["auth.sign_in_code", "auth.invite", "auth.password_reset", "settings.email_replaced"]) {
      await expect(run((tx) => saveMessage(coord.actor, tx, key, { subject: "x", body: "{{code}} {{invite.link}} {{reset.link}}" })), key).rejects.toBeInstanceOf(ForbiddenError);
      expect((await run((tx) => messageForEditor(coord.actor, tx, key))).editable).toBe(false);
    }
    await expect(run((tx) => resetMessage(coord.actor, tx, "auth.invite"))).rejects.toBeInstanceOf(ForbiddenError);
    await run((tx) => saveMessage(admin.actor, tx, "auth.invite", { subject: "Welcome to {{agency.name}}", body: "Set your password here:\n\n{{invite.link}}" }));
    const invitee = await person("personnel");
    await run((tx) => createInvite(admin.actor, tx, invitee.row.id));
    await drain();
    const m = mail.sent.find((x) => x.to.includes(invitee.row.email));
    expect(m?.subject).toBe("Welcome to Your Agency");
    expect(m?.text).toMatch(/^Set your password here:\n\nhttp:\/\/localhost:3000\/accept-invite\?token=/);
    expect(m?.auth).toBe(true);
  });

  test("a value cannot add HTML or links", async () => {
    const deputy = await person("personnel");
    await run((tx) => emit(tx, { type: "job.changed", recipients: [deputy.row.id], title: "Changed", body: 'Vendor <a href="https://evil.example">Pay here</a>', link: "/jobs/abc" }));
    await drainNotifications();
    expect(mail.sent[0].html).not.toContain('<a href="https://evil.example"');
    expect(mail.sent[0].html).toContain("&lt;a href=&quot;https://evil.example&quot;&gt;Pay here&lt;/a&gt;");
  });

  test("send me a test goes to the editor with sample values and is audited; the list groups every message", async () => {
    const coord = await person("coordinator");
    const to = await sendTestMessage(coord.actor, (fn) => run(fn), "job.reminder", { subject: "Soon: Detail #{{detail.number}}", body: "Note: {{reminder.note}}" });
    expect(to).toBe(coord.row.email);
    expect(mail.sent[0]).toMatchObject({ to: [coord.row.email], subject: "Test: Soon: Detail #1042", text: "Note: Check in with the gate officer." });
    expect(await get().db.select().from(auditLog).where(eq(auditLog.action, "email_message.test"))).toHaveLength(1);
    // A draft that breaks the rules is not sent.
    await expect(sendTestMessage(coord.actor, (fn) => run(fn), "job.reminder", { subject: "x", body: "{{code}}" })).rejects.toBeInstanceOf(ValidationError);
    const groups = await run((tx) => listMessages(coord.actor, tx));
    expect(groups.map((g) => g.group)).toContain("Detail reminders");
    expect(groups.flatMap((g) => g.messages.map((m) => m.key))).toEqual(expect.arrayContaining(["auth.sign_in_code", "invoice.batch", "job.reminder", "job.reminder.confidential", "w9.renewal_requested"]));
    expect(groups.flatMap((g) => g.messages.map((m) => m.key))).not.toContain("user.suspended");
    const deputy = await person("personnel");
    await expect(run((tx) => listMessages(deputy.actor, tx))).rejects.toBeInstanceOf(ForbiddenError);
  });
});
