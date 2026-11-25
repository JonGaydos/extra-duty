import { describe, expect, test } from "vitest";
import { download } from "@/app/api/v1/reports/parse";
import { centsText, csvCell, toCsv } from "@/lib/csv";

describe("download", () => {
  test.each([
    ["csv", "text/csv; charset=utf-8"],
    ["pdf", "application/pdf"],
  ] as const)("%s has the right type, an attachment name and nosniff", async (format, type) => {
    const res = download(Buffer.from("abc"), format, "report");
    expect(res.headers.get("content-type")).toBe(type);
    expect(res.headers.get("content-disposition")).toBe(`attachment; filename="report.${format}"`);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await res.text()).toBe("abc");
  });
});

describe("csv helpers", () => {
  test("quotes per RFC 4180 and guards formulas", () => {
    expect(csvCell('a,"b"')).toBe('"a,""b"""');
    expect(csvCell("=1+1")).toBe("'=1+1");
    expect(toCsv(["A", "B"], [["1", "x,y"]])).toBe('A,B\r\n1,"x,y"\r\n');
  });
  test("cents as dollars", () => {
    expect(centsText(12345)).toBe("123.45");
    expect(centsText(5)).toBe("0.05");
    expect(centsText(-250)).toBe("-2.50");
  });
});
