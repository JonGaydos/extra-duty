import { describe, expect, it } from "vitest";
import { auditGroup, auditLabel } from "@/domain/audit/labels";
import { auditChanges, changesText, redact, REDACTED } from "@/domain/audit/search";
import { canonicalJson, formatRecordId, parseRecordId } from "@/domain/audit/records";

describe("audit action groups", () => {
  it("puts actions in plain-word groups, with exports and payment marks pulled out of their prefix", () => {
    expect(auditGroup("auth.sign_in")).toBe("security");
    expect(auditGroup("user.lock")).toBe("security");
    expect(auditGroup("job.cancel")).toBe("details");
    expect(auditGroup("assignment.offer")).toBe("signups");
    expect(auditGroup("invoice.send")).toBe("billing");
    expect(auditGroup("invoice.markPaid")).toBe("payments");
    expect(auditGroup("paymentIssue.report")).toBe("payments");
    expect(auditGroup("w9.approve")).toBe("w9");
    expect(auditGroup("rank.rename")).toBe("users");
    expect(auditGroup("settings.update")).toBe("settings");
    expect(auditGroup("message.acknowledge")).toBe("messages");
    expect(auditGroup("report.export")).toBe("exports");
    expect(auditGroup("message.ack_export")).toBe("exports");
    expect(auditGroup("audit.print")).toBe("exports");
    expect(auditGroup("something.new")).toBe("other");
    expect(auditLabel("audit.print")).toBe("Audit Record printed");
  });
});

describe("secrets in exports", () => {
  it("never shows passwords, tokens, key secrets, file contents or W-9 tax ids", () => {
    expect(redact({ name: "Pat", passwordHash: "x", tokenHash: "y", apiKeySecret: "z", contents: "PDF", nested: { smtpPassword: "p", tin: "123" } })).toEqual({
      name: "Pat",
      passwordHash: REDACTED,
      tokenHash: REDACTED,
      apiKeySecret: REDACTED,
      contents: REDACTED,
      nested: { smtpPassword: REDACTED, tin: REDACTED },
    });
    expect(redact({ status: "approved", name: "Pat Lee", address: "1 Main" }, "w9")).toEqual({ status: "approved", name: REDACTED, address: REDACTED });
  });

  it("reads before and after field by field", () => {
    const c = auditChanges({ rateCents: 6500, title: "A", same: 1 }, { rateCents: 7000, title: "A", same: 1, held: true });
    expect(changesText(c)).toBe("Rate cents: 6500 to 7000; Held: none to true");
    expect(auditChanges(null, null)).toEqual([]);
    expect(auditChanges(null, { password: "x" })).toEqual([{ field: "Password", before: "none", after: REDACTED }]);
  });
});

describe("record IDs and canonical data", () => {
  it("formats and reads record IDs", () => {
    expect(formatRecordId(12)).toBe("AR-000012");
    expect(parseRecordId("AR-000012")).toBe(12);
    expect(parseRecordId(" ar 12 ")).toBe(12);
    expect(parseRecordId("12")).toBe(12);
    expect(parseRecordId("XY-1")).toBeNull();
  });

  it("sorts keys at every level", () => {
    expect(canonicalJson({ b: [{ d: 1, c: 2 }], a: null, at: new Date("2035-01-01T00:00:00Z") })).toBe('{"a":null,"at":"2035-01-01T00:00:00.000Z","b":[{"c":2,"d":1}]}');
  });
});
