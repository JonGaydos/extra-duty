import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, test } from "vitest";
import { agencyChannelOn, agencyChannelsProblem, CATALOG, channelsFor, groupFor, RECIPIENT_GROUPS, type CatalogKey } from "@/domain/notifications/catalog";
import { NOTIFICATION_TYPES } from "@/domain/notifications/types";
import { isMessageKey } from "@/domain/email-messages/catalog";
import { byText } from "@/lib/sort";

const ROOT = join(__dirname, "../../..");

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return files(path);
    return /\.(ts|tsx)$/.test(name) ? [path] : [];
  });
}

/**
 * Every place the app hands an email to a sender or the email queues, and the catalog entry it sends. The notify
 * path (inbox, email and push per type) is "notify"; the queue workers deliver what was queued elsewhere.
 */
const SEND_SITES: Array<{ file: string; call: string; key: CatalogKey | "notify" | "queue worker" | "auth wrapper" | "message test" }> = [
  // Send me a test, on the Email messages editor: the draft, to the editor's own address.
  { file: "src/domain/email-messages/store.ts", call: "getEmailSender().send(", key: "message test" },
  { file: "src/domain/auth/invites.ts", call: "queueEmail(", key: "auth.invite" },
  { file: "src/domain/invoices/batch.ts", call: "queueInvoiceBatchJob(", key: "invoice.delivery" },
  { file: "src/domain/invoices/batch.ts", call: "getEmailSender().send(", key: "invoice.delivery" },
  { file: "src/domain/invoices/email.ts", call: "queueInvoiceJob(", key: "invoice.delivery" },
  // A staff resend of an invoice already sent: the same invoice email.
  { file: "src/domain/invoices/email.ts", call: "queueInvoiceJob(", key: "invoice.delivery" },
  { file: "src/domain/invoices/email.ts", call: "getEmailSender().send(", key: "invoice.delivery" },
  { file: "src/domain/payment-issues/issues.ts", call: "queueEmail(", key: "payment_issue.waiting_on" },
  { file: "src/domain/payment-issues/issues.ts", call: "vendorEmail(", key: "payment_issue.waiting_on" },
  { file: "src/domain/settings/test-email.ts", call: "makeSender(s.email).send(", key: "settings.test_email" },
  { file: "src/jobs/email-worker.ts", call: "getEmailSender().send(", key: "queue worker" },
  { file: "src/jobs/notification-worker.ts", call: "getEmailSender().send(", key: "notify" },
  { file: "src/jobs/vendor-reminders.ts", call: "vendorEmail(", key: "invoice.vendor_payment_reminder" },
  { file: "src/lib/auth.ts", call: "emailSender.send(", key: "auth.password_reset" },
  { file: "src/lib/auth.ts", call: "emailSender.send(", key: "auth.sign_in_code" },
  { file: "src/lib/auth.ts", call: "getEmailSender().send(", key: "auth wrapper" },
];

const SEND = /\b(?:queueEmail|queueInvoiceJob|queueInvoiceBatchJob|vendorEmail)\(|(?:getEmailSender\(\)|emailSender|makeSender\([^)]*\))\.send\(/g;

describe("notification catalog", () => {
  test("lists every notification type", () => {
    for (const t of NOTIFICATION_TYPES) expect(CATALOG[t], t).toBeDefined();
  });

  test("every email the app sends outside the notify path is listed", () => {
    const found: string[] = [];
    for (const path of files(join(ROOT, "src"))) {
      const src = readFileSync(path, "utf8");
      for (const m of src.matchAll(SEND)) {
        // The definitions themselves are not sends.
        if (/function\s+\w+\($/.test(src.slice(Math.max(0, (m.index ?? 0) - 30), (m.index ?? 0) + m[0].length))) continue;
        found.push(`${relative(ROOT, path)} ${m[0]}`);
      }
    }
    expect(found.toSorted(byText)).toEqual(SEND_SITES.map((s) => `${s.file} ${s.call}`).sort(byText));
    for (const s of SEND_SITES) if (!["notify", "queue worker", "auth wrapper", "message test"].includes(s.key)) expect(CATALOG[s.key as CatalogKey], s.key).toBeDefined();
  });

  test("every email is built from an editable message, never written out in code", () => {
    // Only the message renderer builds email bodies; the rest only pass them along (queue, outbox, mail adapters).
    const CARRIERS = new Set([
      "src/domain/email-messages/render.ts",
      "src/domain/email-messages/store.ts",
      "src/lib/email/alert-email.ts",
      "src/lib/email/types.ts",
      "src/lib/email/outbox.ts",
      "src/lib/email/adapters.ts",
      "src/jobs/boss.ts",
      "src/db/schema/training.ts",
    ]);
    const builders = files(join(ROOT, "src"))
      .filter((path) => path.endsWith(".ts") && /\bhtml\s*[:,]/.test(readFileSync(path, "utf8")))
      .map((path) => relative(ROOT, path))
      .filter((path) => !CARRIERS.has(path));
    expect(builders).toEqual([]);
    // Each place that sends builds its email from a message.
    for (const site of new Set(SEND_SITES.filter((x) => x.key !== "queue worker" && x.key !== "auth wrapper").map((x) => x.file))) {
      expect(readFileSync(join(ROOT, site), "utf8"), site).toMatch(/\b(buildEmail|alertEmail|vendorEmail|renderMessage)\(/);
    }
    // Every email-only entry and every alert type has a message to edit.
    for (const [key, entry] of Object.entries(CATALOG)) if (!entry.unused && !entry.inAppOnly && key !== "invoice.delivery" && key !== "invoice.vendor_payment_reminder") expect(isMessageKey(key), key).toBe(true);
    expect(isMessageKey("invoice.delivery") && isMessageKey("invoice.revised") && isMessageKey("invoice.batch") && isMessageKey("payment_issue.vendor")).toBe(true);
    expect(readFileSync(join(ROOT, "src/domain/notifications/notify.ts"), "utf8")).toMatch(/renderMessage\(message/);
  });

  test("with nothing stored every switch is on", () => {
    for (const [key, entry] of Object.entries(CATALOG)) {
      for (const group of entry.groups) {
        for (const channel of channelsFor(entry, group)) expect(agencyChannelOn({}, key as CatalogKey, group, channel), `${key} ${group} ${channel}`).toBe(true);
      }
    }
  });

  test("locked types are sign-in codes, invites, password reset, the invoice to the vendor, the test email and a replaced email server", () => {
    const locked = Object.entries(CATALOG)
      .filter(([, e]) => e.locked)
      .map(([k]) => k)
      .sort(byText);
    expect(locked).toEqual(["auth.invite", "auth.password_reset", "auth.sign_in_code", "invoice.delivery", "settings.email_replaced", "settings.test_email"]);
    expect(agencyChannelsProblem({ "auth.sign_in_code": { personnel: { email: false } } })).toMatch(/cannot be turned off/);
    expect(agencyChannelsProblem({ "invoice.delivery": { vendor: { email: false } } })).toMatch(/This email is the invoice/);
    // Even a stored off is ignored for a locked type.
    expect(agencyChannelOn({ "auth.invite": { vendor: { email: false } } }, "auth.invite", "vendor", "email")).toBe(true);
  });

  test("refuses unknown types, groups that do not get the type, and push to vendors", () => {
    expect(agencyChannelsProblem({ "job.nope": { personnel: { email: false } } })).toMatch(/Unknown notification type/);
    expect(agencyChannelsProblem({ "job.changed": { vendor: { email: false } } })).toMatch(/has no email for Vendors/);
    expect(agencyChannelsProblem({ "job.reactivated": { vendor: { push: false } } })).toMatch(/has no push/);
    expect(agencyChannelsProblem({ "job.reactivated": { vendor: { email: false }, personnel: { push: false } } })).toBeNull();
  });

  test("staff get detail alerts as personnel and staff alerts as staff", () => {
    expect(groupFor("coordinator", CATALOG["job.changed"])).toBe("personnel");
    expect(groupFor("admin", CATALOG["invoice.email_failed"])).toBe("staff");
    expect(groupFor("personnel", CATALOG["invoice.email_failed"])).toBe("personnel");
    expect(groupFor("vendor", CATALOG["job.reactivated"])).toBe("vendor");
    expect(RECIPIENT_GROUPS).toEqual(["vendor", "personnel", "staff"]);
  });
});
