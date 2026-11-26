import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import { Table } from "@/ui/components/Table";

test("a table is not a tab stop until it actually scrolls", () => {
  const html = renderToStaticMarkup(
    <Table
      caption="Invoices"
      columns={[{ header: "Vendor", render: (r: { v: string }) => r.v }]}
      rows={[{ v: "Lantern Events LLC" }]}
      rowKey={(r) => r.v}
    />,
  );
  expect(html).toContain("<caption");
  expect(html).not.toContain("tabindex");
  expect(html).not.toContain("aria-label");
});
