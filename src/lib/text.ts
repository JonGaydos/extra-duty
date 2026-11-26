/** `value` without any slashes at its end ("https://site.example/" becomes "https://site.example"). */
export function trimTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value[end - 1] === "/") end--;
  return value.slice(0, end);
}

/** A stored setting as form text: strings, numbers and booleans as written, anything else (missing or not a plain value) as "". */
export function scalarText(value: unknown): string {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean" || typeof value === "bigint" ? String(value) : "";
}
