import type { Cents } from "@/domain/types";

/** RFC 4180 quoting, plus a leading single quote on text that a spreadsheet would run as a formula. */
export function csvCell(value: string): string {
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/** Header and rows as CRLF-terminated CSV text. */
export function toCsv(header: string[], rows: string[][]): string {
  return [header, ...rows].map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n";
}

/** Cents as plain decimal dollars: 12345 becomes "123.45". */
export function centsText(c: Cents): string {
  const abs = Math.abs(c);
  return `${c < 0 ? "-" : ""}${Math.trunc(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}
