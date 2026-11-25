/**
 * A number with its limit, such as hours against a cap: "6 / 16 h". The
 * warning tone marks a limit that is close.
 */
export function StatTile({
  label,
  value,
  unit,
  tone = "default",
}: {
  label: string;
  value: string | number;
  /** Shown after the value in the muted style, such as "/ 16 h". */
  unit?: string;
  tone?: "default" | "warning";
}) {
  const warn = tone === "warning";
  return (
    <div
      className={`flex flex-col gap-0.5 rounded-tile border p-3 ${
        warn ? "border-warning-line bg-warning-soft" : "border-line bg-surface"
      }`}
    >
      <span className={`text-xs ${warn ? "text-warning-ink" : "text-muted"}`}>{label}</span>
      <span className={`text-stat font-bold ${warn ? "text-warning-ink" : ""}`} data-numeric>
        {value}
        {unit ? <span className={`text-sm font-medium ${warn ? "" : "text-muted"}`}> {unit}</span> : null}
      </span>
    </div>
  );
}
