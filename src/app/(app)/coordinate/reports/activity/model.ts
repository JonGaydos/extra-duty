/** The engine's result for the activity dataset (grouped by person only). */
export type ActivityResult = { columns: string[]; rows: Array<Array<string | number | null>>; keys: string[][]; totals: Record<string, number> };

export type ActivityRow = { userId: string; name: string; values: Record<string, number | null> };

export function activityRows(r: ActivityResult): ActivityRow[] {
  return r.rows.map((row, i) => ({
    userId: r.keys[i]?.[0] ?? "",
    name: String(row[0] ?? ""),
    values: Object.fromEntries(r.columns.slice(1).map((c, j) => [c, (row[j + 1] as number | null) ?? null])),
  }));
}

const byName = (a: ActivityRow, b: ActivityRow) => a.name.localeCompare(b.name);

/** By name or any measure; ties fall back to the name, and blank values (no sign-ups) always go last. */
export function sortRows(rows: ActivityRow[], column: string, dir: "asc" | "desc"): ActivityRow[] {
  const sign = dir === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => {
    if (column === "name") return sign * byName(a, b);
    const x = a.values[column] ?? null;
    const y = b.values[column] ?? null;
    if (x === null || y === null) {
      if (x === y) return byName(a, b);
      return x === null ? 1 : -1;
    }
    return x === y ? byName(a, b) : sign * (x - y);
  });
}

/** The top `n` people on one measure, leaving out anyone at zero. */
export function leaders(rows: ActivityRow[], column: string, n = 5): ActivityRow[] {
  return sortRows(rows.filter((r) => (r.values[column] ?? 0) > 0), column, "desc").slice(0, n);
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "Nov 1 to Nov 30, 2026", or both years when the range crosses one. Agency days, as YYYY-MM-DD. */
export function rangeText(r: { from: string; to: string }): string {
  const [fy, fm, fd] = r.from.split("-").map(Number);
  const [ty, tm, td] = r.to.split("-").map(Number);
  if (!fy || !ty) return `${r.from} to ${r.to}`;
  const from = `${MONTHS[fm - 1]} ${fd}`;
  const to = `${MONTHS[tm - 1]} ${td}, ${ty}`;
  return fy === ty ? `${from} to ${to}` : `${from}, ${fy} to ${to}`;
}
