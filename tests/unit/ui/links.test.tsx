import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { ActionLink, ButtonLink } from "@/ui/components/Button";
import { EmailLinks, PhoneLink, SiteContact } from "@/ui/components/ContactList";
import { Disclosure } from "@/ui/components/Disclosure";

const tokens = readFileSync(join(process.cwd(), "src/ui/tokens.css"), "utf8");

describe("link rules (Task 39c)", () => {
  test("every text link is underlined at rest, 1 px at 3 px offset in half-strength currentColor, full and 2 px on hover and focus", () => {
    const base = /\n {2}a \{([^}]*)\}/.exec(tokens)?.[1] ?? "";
    expect(base).toMatch(/text-decoration-line: underline;/);
    expect(base).toMatch(/text-decoration-thickness: 1px;/);
    expect(base).toMatch(/text-underline-offset: 3px;/);
    expect(base).toMatch(/text-decoration-color: color-mix\(in srgb, currentColor 50%, transparent\);/);
    const hover = /\n {2}a:hover,\n {2}a:focus-visible \{([^}]*)\}/.exec(tokens)?.[1] ?? "";
    expect(hover).toMatch(/text-decoration-thickness: 2px;/);
    expect(hover).toMatch(/text-decoration-color: currentColor;/);
  });

  test("a button-styled link has no underline and says so", () => {
    const html = renderToStaticMarkup(<ButtonLink href="/x">View detail</ButtonLink>);
    expect(html).toContain("no-underline");
    expect(html).toContain("data-button-link");
  });

  test("a standalone action link keeps the underline, a trailing icon and a 44 px hit area", () => {
    const html = renderToStaticMarkup(<ActionLink href="/invoices/1">View invoice</ActionLink>);
    expect(html).not.toContain("no-underline");
    expect(html).toContain("min-h-11");
    expect(html.indexOf("View invoice")).toBeLessThan(html.indexOf("<svg"));
    const ext = renderToStaticMarkup(<ActionLink href="https://example.test" external>Directions</ActionLink>);
    expect(ext).toContain('target="_blank"');
    expect(ext).toContain('rel="noreferrer"');
  });

  test("a phone number is a tel: link with a leading phone icon and the full number", () => {
    const html = renderToStaticMarkup(<PhoneLink phone="850-555-0199" />);
    expect(html).toMatch(/^<a href="tel:\+18505550199"[^>]*><svg/);
    expect(html).toContain("850-555-0199</");
  });

  test("an email is a mailto: link with a leading mail icon", () => {
    const html = renderToStaticMarkup(<EmailLinks emails={["billing@harborfront.example"]} />);
    expect(html).toMatch(/<a href="mailto:billing@harborfront.example"[^>]*><svg/);
  });

  test("the site contact shows the name, then the number on its own line; a bad number shows as typed, flagged to staff only", () => {
    const good = renderToStaticMarkup(<SiteContact name="Rowan Fairley" phone="850-555-0199" staff={false} />);
    expect(good).toContain("Rowan Fairley");
    expect(good).toContain('href="tel:+18505550199"');
    const bad = renderToStaticMarkup(<SiteContact name="123" phone="13" staff />);
    expect(bad).toContain(">13<");
    expect(bad).not.toContain("tel:");
    expect(bad).toContain("Check this number");
    expect(renderToStaticMarkup(<SiteContact name="123" phone="13" staff={false} />)).not.toContain("Check this number");
  });

  test("a disclosure toggle is a button with aria-expanded and a chevron, not a link", () => {
    const html = renderToStaticMarkup(
      <Disclosure label="9 other checks passed">
        <p>Hidden</p>
      </Disclosure>,
    );
    expect(html).toMatch(/^<div[^>]*><button type="button" aria-expanded="false"/);
    expect(html).toContain("<svg");
    expect(html).not.toContain("<a ");
    expect(html).not.toContain("Hidden");
  });
});
