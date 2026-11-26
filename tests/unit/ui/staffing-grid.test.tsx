import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { StaffingGrid } from "@/ui/components/StaffingGrid";

/** How many times `re` (a global pattern) matches. */
const count = (html: string, re: RegExp) => [...html.matchAll(re)].length;

describe("StaffingGrid", () => {
  const html = renderToStaticMarkup(
    <StaffingGrid
      positions={[
        { name: "Dispatcher", filled: 1, requested: 1, backups: 0 },
        { name: "Incident Commander", filled: 1, requested: 1, backups: 0 },
        { name: "Deputy Sheriff", filled: 14, requested: 14, backups: 2 },
        { name: "CSO", filled: 1, requested: 1, backups: 0 },
      ]}
    />,
  );

  test("is one image with a summary label", () => {
    expect(count(html, /role="img"/g)).toBe(1);
    expect(html).toContain('aria-label="17 of 17 spots filled, 2 backups waiting"');
  });

  test("renders four labeled rows", () => {
    expect(count(html, /data-staffing-row=/g)).toBe(4);
    for (const name of ["Dispatcher", "Incident Commander", "Deputy Sheriff", "CSO"]) {
      expect(html).toContain(`data-staffing-row="${name}"`);
      expect(html).toContain(`>${name}</`);
    }
  });

  test("renders 19 squares: 17 filled and 2 backups", () => {
    expect(count(html, /data-square="/g)).toBe(19);
    expect(count(html, /data-square="filled"/g)).toBe(17);
    expect(count(html, /data-square="open"/g)).toBe(0);
    expect(count(html, /data-square="backup"/g)).toBe(2);
  });

  test("open spots are outlined squares and the label counts them", () => {
    const partial = renderToStaticMarkup(
      <StaffingGrid
        positions={[
          { name: "Deputy Sheriff", filled: 1, requested: 2, backups: 1 },
          { name: "CSO", filled: 0, requested: 1, backups: 0 },
        ]}
      />,
    );
    expect(count(partial, /data-square="open"/g)).toBe(2);
    expect(partial).toContain(
      'aria-label="1 of 3 spots filled: Deputy Sheriff 1 open, CSO 1 open. 1 backup waiting"',
    );
  });

  test("the label names the positions with open spots", () => {
    const html = renderToStaticMarkup(
      <StaffingGrid
        positions={[
          { name: "Dispatcher", filled: 1, requested: 1, backups: 0 },
          { name: "Deputy Sheriff", filled: 12, requested: 14, backups: 2 },
          { name: "CSO", filled: 1, requested: 1, backups: 0 },
          { name: "Incident Commander", filled: 1, requested: 1, backups: 0 },
        ]}
      />,
    );
    expect(html).toContain('aria-label="15 of 17 spots filled: Deputy Sheriff 2 open. 2 backups waiting"');
  });

  test("a single spot with no backups reads naturally", () => {
    const one = renderToStaticMarkup(<StaffingGrid positions={[{ name: "CSO", filled: 0, requested: 1, backups: 0 }]} />);
    expect(one).toContain('aria-label="0 of 1 spot filled: CSO 1 open"');
  });

  test("bad counts are treated as zero instead of throwing", () => {
    const html = renderToStaticMarkup(
      <StaffingGrid positions={[{ name: "CSO", filled: -1, requested: -2, backups: -3 }]} />,
    );
    expect(count(html, /data-square="/g)).toBe(0);
    expect(html).toContain('aria-label="0 of 0 spots filled"');
  });

  test("two positions with the same name both render (rows keyed by id or position)", () => {
    const html = renderToStaticMarkup(
      <StaffingGrid
        positions={[
          { id: "a", name: "Deputy Sheriff", filled: 1, requested: 1, backups: 0 },
          { id: "b", name: "Deputy Sheriff", filled: 0, requested: 1, backups: 0 },
        ]}
      />,
    );
    expect(count(html, /data-staffing-row=/g)).toBe(2);
    expect(count(html, /data-square="/g)).toBe(2);
  });
});
