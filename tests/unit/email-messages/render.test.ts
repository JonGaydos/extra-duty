import { describe, expect, test } from "vitest";
import { MESSAGES, type MessageKey } from "@/domain/email-messages/catalog";
import { sampleValues } from "@/domain/email-messages/placeholders";
import { messageProblem, placeholdersIn, renderMessage } from "@/domain/email-messages/render";
import { CATALOG } from "@/domain/notifications/catalog";
import { NOTIFICATION_TYPES } from "@/domain/notifications/types";
import { byText } from "@/lib/sort";

const def = (k: MessageKey) => MESSAGES[k];

describe("email messages", () => {
  test("placeholders render in the subject and body, in text and HTML", () => {
    const r = renderMessage({ subject: "Hi {{person.firstName}}", body: "Detail #{{detail.number}} at {{detail.location}}.\n\nSee {{link}}" }, {
      "person.firstName": "Jordan",
      "detail.number": "1042",
      "detail.location": "North Field",
      link: "https://app.example.org/jobs/1",
    });
    expect(r.subject).toBe("Hi Jordan");
    expect(r.text).toBe("Detail #1042 at North Field.\n\nSee https://app.example.org/jobs/1");
    expect(r.html).toBe('<p>Detail #1042 at North Field.</p>\n<p>See <a href="https://app.example.org/jobs/1">https://app.example.org/jobs/1</a></p>');
  });

  test("values are escaped and never become links; addresses the editor wrote do", () => {
    const r = renderMessage({ subject: "{{vendor.name}}", body: "From {{vendor.name}}. Help: https://help.example.org/start." }, {
      "vendor.name": '<a href="https://evil.example">Click</a> https://evil.example\nBcc: x@example.org',
    });
    expect(r.html).not.toContain('<a href="https://evil.example"');
    expect(r.html).toContain("&lt;a href=&quot;https://evil.example&quot;&gt;Click&lt;/a&gt; https://evil.example");
    expect(r.html).toContain('<a href="https://help.example.org/start">https://help.example.org/start</a>.');
    // The subject stays one line, so a value cannot add a header.
    expect(r.subject).not.toMatch(/[\r\n]/);
  });

  test("a paragraph whose placeholders are all empty is left out, and doubled spaces close up", () => {
    const r = renderMessage({ subject: "x", body: "One.\n\nNote: {{reminder.note}}\n\nTotal: {{invoice.amount}}. {{batch.paidNote}} Pay it." }, { "invoice.amount": "$5" });
    expect(r.text).toBe("One.\n\nTotal: $5. Pay it.");
  });

  test("a value with paragraphs of its own becomes separate paragraphs", () => {
    const r = renderMessage({ subject: "x", body: "{{batch.w9Lines}}" }, { "batch.w9Lines": "W-9 for A is attached.\n\nW-9 for B is attached." });
    expect(r.text).toBe("W-9 for A is attached.\n\nW-9 for B is attached.");
    expect(r.html).toBe("<p>W-9 for A is attached.</p>\n<p>W-9 for B is attached.</p>");
  });

  test("required placeholders cannot be removed", () => {
    expect(messageProblem(def("auth.sign_in_code"), { subject: "Your code", body: "Hello." })).toBe("The sign-in code must stay in this message.");
    expect(messageProblem(def("auth.invite"), { subject: "Welcome", body: "Hello." })).toBe("The account setup link must stay in this message.");
    expect(messageProblem(def("auth.password_reset"), { subject: "Reset", body: "Hello." })).toBe("The password reset link must stay in this message.");
    expect(messageProblem(def("invoice.delivery"), { subject: "Invoice {{invoice.number}}", body: "Hello." })).toBe("The amount due must stay in this message.");
    expect(messageProblem(def("auth.sign_in_code"), { subject: "Your code", body: "Code: {{code}}" })).toBeNull();
  });

  test("unknown placeholders and broken braces are refused", () => {
    expect(messageProblem(def("job.reminder"), { subject: "x", body: "{{invoice.number}}" })).toMatch(/^\{\{invoice\.number\}\} is not a placeholder this message can use/);
    expect(messageProblem(def("job.reminder"), { subject: "x", body: "{{nope}}" })).toMatch(/is not a placeholder/);
    expect(messageProblem(def("job.reminder"), { subject: "x", body: "{{detail.title}" })).toMatch(/missing a brace/);
    expect(messageProblem(def("job.reminder"), { subject: "", body: "x" })).toBe("Write a subject.");
  });

  test("confidential variants may use only the date and time", () => {
    for (const k of ["job.reminder.confidential", "confidential.assigned", "confidential.update"] as const) {
      expect(def(k).confidential).toBe(true);
      for (const secret of ["detail.title", "detail.location", "vendor.name", "detail.description", "reminder.note"]) {
        expect(messageProblem(def(k), { subject: "x", body: `{{${secret}}}` }), `${k} ${secret}`).toBe(`A confidential detail's message can use only the date and time, not {{${secret}}}.`);
      }
      expect(messageProblem(def(k), { subject: "On {{detail.date}}", body: "At {{detail.time}}." })).toBeNull();
    }
  });

  test("sign-in, invite, password reset and security alert emails are admins' only", () => {
    const adminOnly = Object.entries(MESSAGES)
      .filter(([, d]) => d.adminOnly)
      .map(([k]) => k)
      .toSorted(byText);
    expect(adminOnly).toEqual(["auth.invite", "auth.password_reset", "auth.sign_in_code", "settings.email_replaced", "settings.test_email"]);
  });

  test("every alert type that can email has a message, and every default passes its own checks", () => {
    for (const t of NOTIFICATION_TYPES) expect(MESSAGES[t], t).toBeDefined();
    for (const [k, d] of Object.entries(MESSAGES)) {
      expect(messageProblem(d, { subject: d.subject, body: d.body }), k).toBeNull();
      expect(d.hidden === true, k).toBe(k in CATALOG ? Boolean(CATALOG[k as keyof typeof CATALOG].unused || CATALOG[k as keyof typeof CATALOG].inAppOnly) : false);
      for (const p of placeholdersIn(d.subject + d.body)) expect(d.placeholders, `${k} ${p}`).toContain(p);
    }
  });

  test("the defaults keep the built-in wording", () => {
    const code = renderMessage(def("auth.sign_in_code"), { code: "123456", "code.minutes": "10" });
    expect(code).toMatchObject({ subject: "Your sign-in code", text: "Your Signal 90 sign-in code is 123456.\n\nIt expires in 10 minutes. If you did not try to sign in, reset your password." });
    const alert = renderMessage(def("job.changed"), { "alert.title": "Detail changed", "alert.body": "The start time moved.", link: "http://localhost/jobs/1" });
    expect(alert).toMatchObject({ subject: "Detail changed", text: "The start time moved.\n\nOpen in Signal 90: http://localhost/jobs/1" });
    const batch = renderMessage(def("invoice.batch"), { "agency.name": "A", "vendor.name": "V", "batch.count": "2 invoices", "invoice.amount": "$10.00", "batch.payWord": "invoice" });
    expect(batch.subject).toBe("2 invoices from A");
    expect(batch.text).toBe("A is sending 2 invoices to V.\n\nTotal due: $10.00. A summary and each invoice are attached as PDFs. Pay each invoice to the payee named on it.\n\nReply to this message with any billing questions.");
    expect(renderMessage(def("job.reminder"), sampleValues()).text).toContain("Note: Check in with the gate officer.");
  });
});
