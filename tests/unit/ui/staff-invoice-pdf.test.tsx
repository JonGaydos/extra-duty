import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test, vi } from "vitest";

vi.mock("@/app/(app)/coordinate/_coordinator/actions", () => ({}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));

const { StaffInvoice } = await import("@/app/(app)/invoices/[id]/StaffInvoice");
const { InvoicePdfLink } = await import("@/app/(app)/invoices/[id]/InvoicePdfLink");

const at = new Date("2035-12-31T15:00:00Z");
const base = {
  id: "inv-1",
  number: "ED-000001",
  kind: "detail",
  revision: 0,
  payeeUserId: "u1",
  payeeName: "Ann Lee",
  payeeEmail: "ann@example.test",
  payeePhone: null,
  vendorId: "v1",
  vendorName: "Acme",
  vendorBillingEmails: ["ap@acme.example"],
  vendorOnHold: false,
  jobId: "j1",
  jobNumber: 7,
  jobTitle: "Gate",
  scheduled: { startAt: at, endAt: at },
  worked: null,
  changeReason: null,
  minutes: 240,
  rateCents: 7000,
  totalCents: 28000,
  minimumOverrideMinutes: null,
  sendSchedule: "immediate",
  queuedSend: null,
  sendByDefault: true,
  canSendNow: false,
  canSendPaid: false,
  attachW9: false,
  payeeHasW9: false,
  party: null,
  dueAt: null,
  overdue: false,
  issueId: null,
  issueWaitingOn: null,
  timeline: [],
} as const;

describe("staff invoice PDF and resend", () => {
  for (const [status, sentAt] of [["pending_review", null], ["approved_unsent", null], ["sent", at], ["paid", at], ["written_off", null]] as const) {
    test(`Download PDF is offered when the invoice is ${status}`, () => {
      const html = renderToStaticMarkup(<StaffInvoice inv={{ ...base, status, sentAt } as never} issue={null} />);
      expect(html).toContain('href="/api/v1/invoices/inv-1/pdf"');
      expect(html).toContain("Download PDF");
      // Resend is offered only once it has been sent.
      expect(html.includes(">Resend invoice<")).toBe(sentAt !== null);
    });
  }

  test("the compact list link names its invoice for screen readers", () => {
    const html = renderToStaticMarkup(<InvoicePdfLink id="x" number="ED-000009" compact />);
    expect(html).toContain('href="/api/v1/invoices/x/pdf"');
    expect(html).toContain(" for invoice ED-000009");
  });
});
