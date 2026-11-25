import { describe, expect, test } from "vitest";
import { routes } from "@/lib/api/registry";
import { openApiDocument } from "@/lib/api/openapi";
import { agencyDateParts, agencyInstant } from "@/domain/time/agency-time";

type Paid = { paymentMethodId: string; reference: string; paidAt: Date };
const paid = (body: unknown) => routes["POST /billing/invoices/{id}/mark-paid"].body.parse(body) as Paid;
const vendorPaid = (body: unknown) => routes["POST /billing/invoices/{id}/vendor-mark-paid"].body.parse(body) as Paid;
const period = (body: unknown) => routes["POST /reports/saved/{id}/run"].body.parse(body) as { from?: Date; to?: Date };

describe("date-only input is agency midnight", () => {
  test("a paid date of 2027-01-01 counts in 2027 and is midnight Central", () => {
    const { paidAt, reference } = paid({ paymentMethodId: "m", paidAt: "2027-01-01" });
    expect(paidAt.getTime()).toBe(agencyInstant(2027, 1, 1, 0, 0).getTime());
    expect(paidAt.toISOString()).toBe("2027-01-01T06:00:00.000Z");
    expect(agencyDateParts(paidAt).year).toBe(2027);
    expect(reference).toBe("");
  });

  test("a vendor's paid date on the spring-forward day is agency midnight (CST), and on the fall-back day too (CDT)", () => {
    expect(vendorPaid({ paymentMethodId: "m", paidAt: "2026-03-08" }).paidAt.toISOString()).toBe("2026-03-08T06:00:00.000Z");
    expect(vendorPaid({ paymentMethodId: "m", paidAt: "2026-11-01" }).paidAt.toISOString()).toBe("2026-11-01T05:00:00.000Z");
  });

  test("a full timestamp is kept as given; an impossible date or no method is refused", () => {
    expect(paid({ paymentMethodId: "m", paidAt: "2027-01-01T03:00:00Z" }).paidAt.toISOString()).toBe("2027-01-01T03:00:00.000Z");
    expect(routes["POST /billing/invoices/{id}/mark-paid"].body.safeParse({ paymentMethodId: "m", paidAt: "2027-02-30" }).success).toBe(false);
    expect(routes["POST /billing/invoices/{id}/mark-paid"].body.safeParse({ paymentMethodId: "", paidAt: "2027-01-01" }).success).toBe(false);
  });

  test("a report period runs from the start of From to the end of To", () => {
    const p = period({ from: "2026-11-01", to: "2026-11-30" });
    expect(p.from!.getTime()).toBe(agencyInstant(2026, 11, 1, 0, 0).getTime());
    expect(p.to!.getTime()).toBe(agencyInstant(2026, 12, 1, 0, 0).getTime() - 1);
    const e = routes["POST /reports/saved/{id}/export"].body.parse({ from: "2026-03-08", to: "2026-03-08", format: "csv" }) as { from: Date; to: Date };
    expect(e.from.toISOString()).toBe("2026-03-08T06:00:00.000Z");
    expect(e.to.toISOString()).toBe("2026-03-09T04:59:59.999Z");
  });

  test("the OpenAPI document describes the paid date and the period as dates", () => {
    const doc = openApiDocument() as { paths: Record<string, Record<string, { requestBody: { content: Record<string, { schema: { properties: Record<string, { format?: string }> } }> } }>> };
    const body = (path: string) => doc.paths[path].post.requestBody.content["application/json"].schema.properties;
    expect(body("/api/v1/billing/invoices/{id}/vendor-mark-paid").paidAt.format).toBe("date-time");
    expect(body("/api/v1/reports/saved/{id}/export").from.format).toBe("date-time");
  });
});
