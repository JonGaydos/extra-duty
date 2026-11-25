import { deflateSync } from "node:zlib";
import { describe, expect, test } from "vitest";
import { PDFParse } from "pdf-parse";
import { pdfLogoBox, renderInvoicePdf, type InvoicePdfData } from "@/lib/pdf/invoice-pdf";
import { agencyInstant } from "@/domain/time/agency-time";

function crc32(buf: Buffer): number {
  let c = ~0;
  for (const b of buf) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
  }
  return ~c >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** A valid 2x2 red RGB PNG. */
function tinyPng(): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(2, 0);
  ihdr.writeUInt32BE(2, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const row = Buffer.from([0, 255, 0, 0, 255, 0, 0]);
  const raw = Buffer.concat([row, row]);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function data(over: Partial<InvoicePdfData> = {}): InvoicePdfData {
  return {
    number: "ED-000042",
    revision: 0,
    kind: "detail",
    issuedAt: agencyInstant(2026, 12, 5, 9, 0),
    vendor: { name: "Lakeside Stadium", billingEmails: ["ap@lakeside.example"] },
    job: {
      number: 17,
      title: "Stadium security",
      location: "100 Main St, Cedar Springs",
      startAt: agencyInstant(2026, 12, 4, 17, 30),
      endAt: agencyInstant(2026, 12, 4, 21, 30),
    },
    payee: { name: "Dana Whitaker", mailingAddress: "12 Oak Lane\nCedar Springs, FL 32403", email: "dana@example.test" },
    agency: {
      name: "Bayside County Sheriff's Office",
      sheriffName: "Jane Doe",
      address: "1 Courthouse Sq",
      phone: "850-555-0100",
      website: "https://sheriff.example",
      logo: null,
    },
    workedMinutes: 240,
    minutes: 360,
    minimumMinutes: 240,
    rateCents: 7500,
    totalCents: 45000,
    paid: null,
    replyTo: "billing@sheriff.example",
    ...over,
  };
}

async function text(pdf: Buffer): Promise<string> {
  const parser = new PDFParse({ data: new Uint8Array(pdf) });
  try {
    return (await parser.getText()).text;
  } finally {
    await parser.destroy();
  }
}

describe("renderInvoicePdf", () => {
  test("contains the number, payee, amount and reply-to address", async () => {
    const t = await text(await renderInvoicePdf(data()));
    expect(t).toContain("ED-000042");
    expect(t).toContain("Dana Whitaker");
    expect(t).toContain("$450.00");
    expect(t).toContain("$75.00/hr");
    expect(t).toContain("billing@sheriff.example");
    expect(t).toContain("Make payment to the payee named above.");
    expect(t).toContain("Fri, Dec 4, 2026, 5:30 PM to 9:30 PM");
  });

  test("shows the payee mailing address and email", async () => {
    const t = await text(await renderInvoicePdf(data()));
    expect(t).toContain("12 Oak Lane");
    expect(t).toContain("Cedar Springs, FL 32403");
    expect(t).toContain("dana@example.test");
  });

  test("shows Revised only when the revision is above zero", async () => {
    const zero = await text(await renderInvoicePdf(data({ revision: 0 })));
    expect(zero).not.toContain("Revised");
    expect(zero).not.toContain("Revision");
    const t = await text(await renderInvoicePdf(data({ revision: 2 })));
    expect(t).toContain("Revised");
    expect(t).toContain("Revision 2");
  });

  test("shows the minimum note only when billed minutes exceed worked minutes", async () => {
    const raised = await text(await renderInvoicePdf(data({ workedMinutes: 120, minutes: 240, totalCents: 30000 })));
    expect(raised).toContain("4-hour minimum applied");
    const notRaised = await text(await renderInvoicePdf(data({ workedMinutes: 240, minutes: 240, totalCents: 30000 })));
    expect(notRaised).not.toContain("minimum applied");
  });

  test("the note uses the resolved minimum in hours", async () => {
    const t = await text(await renderInvoicePdf(data({ workedMinutes: 60, minutes: 180, minimumMinutes: 180, totalCents: 22500 })));
    expect(t).toContain("3-hour minimum applied");
  });

  test("contains the agency name and the sheriff's name, only when set", async () => {
    const t = await text(await renderInvoicePdf(data()));
    expect(t).toContain("Bayside County Sheriff's Office");
    expect(t).toContain("Sheriff Jane Doe");
    const none = await text(
      await renderInvoicePdf(data({ agency: { ...data().agency, sheriffName: "" } })),
    );
    expect(none).not.toContain("Sheriff Jane");
    expect(none).not.toMatch(/Sheriff\s*\n/);
  });

  test("embeds the logo when set and renders without one", async () => {
    const without = await renderInvoicePdf(data());
    const withLogo = await renderInvoicePdf(data({ agency: { ...data().agency, logo: { bytes: tinyPng(), mimeType: "image/png" } } }));
    expect(without.includes(Buffer.from("/Subtype /Image"))).toBe(false);
    expect(withLogo.includes(Buffer.from("/Subtype /Image"))).toBe(true);
  });

  test("a wide logo takes the wide header slot and a square or tall one the square slot, contained", () => {
    expect(pdfLogoBox({ width: 512, height: 171 })).toEqual({ width: 150, height: 50 });
    expect(pdfLogoBox({ width: 512, height: 512 })).toEqual({ width: 56, height: 56 });
    expect(pdfLogoBox({ width: 171, height: 512 })).toEqual({ width: 19, height: 56 });
    expect(pdfLogoBox({})).toEqual({ width: 56, height: 56 });
  });

  test("shows PAID with the reference when paid", async () => {
    const t = await text(
      await renderInvoicePdf(data({ paid: { method: "Check", reference: "CHK-9981", paidAt: agencyInstant(2026, 12, 20, 10, 0) } })),
    );
    expect(t).toContain("PAID");
    expect(t).toContain("CHK-9981");
    expect(await text(await renderInvoicePdf(data()))).not.toContain("PAID");
  });

  test("formats thousands with a separator", async () => {
    const t = await text(await renderInvoicePdf(data({ totalCents: 123450 })));
    expect(t).toContain("$1,234.50");
  });

  test("omits empty agency lines, address lines and payment parts", async () => {
    const t = await text(
      await renderInvoicePdf(
        data({
          agency: { ...data().agency, address: "", phone: "", website: "" },
          payee: { ...data().payee, mailingAddress: "" },
          paid: { method: "", reference: "", paidAt: agencyInstant(2026, 12, 20, 10, 0) },
        }),
      ),
    );
    expect(t.split("-- 1 of 1")[0].trim()).not.toMatch(/\n\s*\n/);
    expect(t).not.toContain(", ,");
    expect(t).toMatch(/PAID Sun, Dec 20, 2026\s*\n/);
    const m = await text(await renderInvoicePdf(data({ paid: { method: "Check", reference: "", paidAt: agencyInstant(2026, 12, 20, 10, 0) } })));
    expect(m).toContain("PAID Sun, Dec 20, 2026, Check");
    expect(m).not.toContain("reference");
  });

  test("falls back to a plain sentence when there is no reply-to address", async () => {
    const t = await text(await renderInvoicePdf(data({ replyTo: "" })));
    expect(t).toContain("Payment questions or disputes: contact the agency");
  });

  test("late cancellation invoices have no hours worked line and no minimum note", async () => {
    const t = await text(await renderInvoicePdf(data({ kind: "late_cancel", workedMinutes: 0, minutes: 240, minimumMinutes: 240, totalCents: 30000 })));
    expect(t).toContain("Late cancellation by the vendor");
    expect(t).toContain("Hours billed");
    expect(t).not.toContain("Hours worked");
    expect(t).not.toContain("minimum applied");
    expect(await text(await renderInvoicePdf(data()))).not.toContain("Late cancellation");
  });
});
