import { describe, expect, test } from "vitest";
import { redactProviderError } from "@/domain/invoices/batch";
import { parseInline, parseMarkdown } from "@/domain/manuals/markdown";
import { isBlockedAddress } from "@/domain/planning/calendar-fetch";
import { withUnit } from "@/lib/address-match";
import { parseAddress } from "@/lib/email/adapters";
import { formatMoney } from "@/lib/pdf/invoice-pdf";

/** Text checks that could slow down on crafted long input: each must stay fast, and normal input reads as before. */
const N = 50_000;
const fast = (fn: () => unknown) => {
  const start = performance.now();
  fn();
  expect(performance.now() - start).toBeLessThan(250);
};

describe("provider error redaction", () => {
  test("is fast on a long hostile message", () => {
    for (const s of ["a".repeat(N), "a@".repeat(N / 2), `${"a".repeat(N)}@b`, "authorization: ".repeat(N / 15)]) fast(() => redactProviderError(s));
  });

  test("still hides addresses and keeps the message short", () => {
    expect(redactProviderError("rejected for ops@vendor.example and <a.b@c.d>")).toBe("rejected for [email] and <[email]>");
    expect(redactProviderError(`${"x ".repeat(5000)}end`)).toHaveLength(300);
  });

  test("never shows part of a secret or an address cut by the length limit", () => {
    expect(redactProviderError(`${"x".repeat(1990)} SECRETKEYabcdefghijklmnopqrstuvwxyz0123`)).toBe("[redacted]");
    expect(redactProviderError(`${"x".repeat(1985)} to jane.doe@example.org failed`)).toBe("[redacted] to");
    expect(redactProviderError(`${"x".repeat(1990)},jane.doe@example.org`)).toBe("[redacted]");
    expect(redactProviderError("y".repeat(2500))).toBe("[redacted]");
  });

  test("keeps a whole word that ends exactly at the length limit", () => {
    expect(redactProviderError(`${"x".repeat(1990)} ok${"z".repeat(7)} next`)).toBe(`[redacted] ok${"z".repeat(7)}`);
  });
});

describe("manual Markdown", () => {
  test("is fast on long hostile lines", () => {
    for (const s of ["[".repeat(N), `**${"a".repeat(N)}`, "*".repeat(N), "`".repeat(N), `[a](${" ".repeat(N)}`, "[a]".repeat(N / 3), "**a".repeat(N / 3)]) fast(() => parseInline(s));
    for (const s of [`#${" ".repeat(N)}`, `-${" ".repeat(N)}`, `1.${" ".repeat(N)}`, `# ${"#".repeat(N)}`]) fast(() => parseMarkdown(s));
  });

  test("reads bold, code and links as before", () => {
    expect(parseInline("Tap **Sign up**, then `Save` or see [Help](/help/deputy).")).toEqual([
      { t: "text", v: "Tap " },
      { t: "strong", v: "Sign up" },
      { t: "text", v: ", then " },
      { t: "code", v: "Save" },
      { t: "text", v: " or see " },
      { t: "link", v: "Help", href: "/help/deputy" },
      { t: "text", v: "." },
    ]);
    expect(parseInline("****x** and **** and ``")).toEqual([{ t: "strong", v: "**x" }, { t: "text", v: " and **** and ``" }]);
    expect(parseInline("[no link](has space) [x]() [](y) [a](b)")).toEqual([{ t: "text", v: "[no link](has space) [x]() [](y) " }, { t: "link", v: "a", href: "b" }]);
    expect(parseInline("**a\nb** `c\nd`")).toEqual([{ t: "text", v: "**a\nb** " }, { t: "code", v: "c\nd" }]);
  });

  test("reads headings and list items as before", () => {
    expect(parseMarkdown("#   Title  \n\n1.   First\n-  Bullet\n#\n# ")).toEqual([
      { type: "heading", level: 1, text: "Title" },
      { type: "list", ordered: true, items: [[{ type: "paragraph", inline: [{ t: "text", v: "First" }] }]] },
      { type: "list", ordered: false, items: [[{ type: "paragraph", inline: [{ t: "text", v: "Bullet" }] }]] },
      { type: "paragraph", inline: [{ t: "text", v: "# #" }] },
    ]);
  });
});

describe("calendar address check", () => {
  test("is fast on a long hostile address", () => {
    for (const s of ["1".repeat(N), `::${"1.".repeat(N / 2)}`, `${"1".repeat(N)}.1.1.1`]) fast(() => isBlockedAddress(s));
  });

  test("reads IPv6 with a dotted IPv4 tail as before", () => {
    expect(isBlockedAddress("::ffff:10.0.0.1")).toBe(true);
    expect(isBlockedAddress("::ffff:8.8.8.8")).toBe(false);
    expect(isBlockedAddress("64:ff9b::8.8.8.8")).toBe(false);
    expect(isBlockedAddress("2001:4860:4860::8888")).toBe(false);
  });
});

describe("unit numbers in addresses", () => {
  test("is fast on a long hostile address", () => {
    for (const s of [`suite${" ".repeat(N)}!`, `apt.${" ".repeat(N)}#${" ".repeat(N)}`, "#".repeat(N)]) fast(() => withUnit(s, "1 Main St, Town"));
  });

  test("puts typed units back as before", () => {
    expect(withUnit("1 Main St Suite  # 4B", "1 Main Street, Town")).toBe("1 Main Street, Suite # 4B, Town");
    expect(withUnit("1 Main St #12", "1 Main Street")).toBe("1 Main Street, #12");
  });
});

describe("sender address parsing", () => {
  test("is fast on a long hostile address", () => {
    for (const s of [`a${" ".repeat(N)}<`, `${" ".repeat(N)}x`, `${"<".repeat(N)}>`, `x${" ".repeat(N)}<a>b`]) fast(() => parseAddress(s));
  });

  test("splits names and addresses as before", () => {
    expect(parseAddress('  "Agency Billing"  <billing@agency.example>  ')).toEqual({ name: "Agency Billing", email: "billing@agency.example" });
    expect(parseAddress("Agency <a@b.c>")).toEqual({ name: "Agency", email: "a@b.c" });
    expect(parseAddress("<a@b.c>")).toEqual({ name: "", email: "a@b.c" });
    expect(parseAddress(" a@b.c ")).toEqual({ name: "", email: "a@b.c" });
    expect(parseAddress("A <x> <a@b.c>")).toEqual({ name: "A <x>", email: "a@b.c" });
    expect(parseAddress("A <a>b@c>")).toEqual({ name: "", email: "A <a>b@c>" });
    expect(parseAddress("A\nB <a@b.c>")).toEqual({ name: "", email: "A\nB <a@b.c>" });
    expect(parseAddress("A <>")).toEqual({ name: "", email: "A <>" });
  });
});

describe("money in the invoice PDF", () => {
  test("groups thousands as before", () => {
    expect([0, 5, 99, 100, 123456, 100000, 99999999, -123456789, 100000000000].map(formatMoney)).toEqual([
      "$0.00",
      "$0.05",
      "$0.99",
      "$1.00",
      "$1,234.56",
      "$1,000.00",
      "$999,999.99",
      "-$1,234,567.89",
      "$1,000,000,000.00",
    ]);
  });

  test("is fast on the largest exact amount", () => {
    fast(() => formatMoney(Number.MAX_SAFE_INTEGER));
    expect(formatMoney(Number.MAX_SAFE_INTEGER)).toBe("$90,071,992,547,409.91");
  });
});
