import { keyedByContent } from "@/lib/list-keys";

export type StaffingPosition = {
  /** Stable key when two positions share a name. */
  id?: string;
  name: string;
  filled: number;
  requested: number;
  backups: number;
};

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
/** Counts come from data; anything negative or not a whole number is drawn as zero. */
const count = (n: number) => (Number.isInteger(n) && n > 0 ? n : 0);

function counts(p: StaffingPosition) {
  const requested = count(p.requested);
  const filled = Math.min(count(p.filled), requested);
  return { requested, filled, open: requested - filled, backups: count(p.backups) };
}

/**
 * "17 of 17 spots filled, 2 backups waiting", or with open spots
 * "15 of 17 spots filled: Deputy Sheriff 2 open. 2 backups waiting".
 */
function staffingSummary(positions: StaffingPosition[]): string {
  const all = positions.map((p) => ({ name: p.name, ...counts(p) }));
  const filled = all.reduce((n, p) => n + p.filled, 0);
  const requested = all.reduce((n, p) => n + p.requested, 0);
  const backups = all.reduce((n, p) => n + p.backups, 0);
  const open = all.filter((p) => p.open > 0).map((p) => `${p.name} ${p.open} open`);
  let text = `${filled} of ${plural(requested, "spot", "spots")} filled`;
  if (open.length > 0) text += `: ${open.join(", ")}`;
  if (backups > 0) text += `${open.length > 0 ? "." : ","} ${plural(backups, "backup", "backups")} waiting`;
  return text;
}

type Kind = "filled" | "open" | "backup";

const SQUARE: Record<Kind, string> = {
  filled: "bg-accent",
  open: "border-2 border-accent-outline",
  backup: "border-2 border-dashed border-warning-strong",
};

/**
 * One labeled row of squares per position: solid for filled spots, outlined
 * for open ones, dashed for backups. Read as one image whose label is the
 * summary, naming each position with open spots; the roster table carries
 * the names of the people.
 */
export function StaffingGrid({ positions, legend = true }: Readonly<{ positions: StaffingPosition[]; legend?: boolean }>) {
  return (
    <div className="flex flex-col gap-3">
      <div role="img" aria-label={staffingSummary(positions)} className="flex flex-col gap-2">
        {keyedByContent(positions, (p) => p.id ?? p.name).map(({ key: rowKey, item: p }) => {
          const c = counts(p);
          const squares: Kind[] = [
            ...new Array<Kind>(c.filled).fill("filled"),
            ...new Array<Kind>(c.open).fill("open"),
            ...new Array<Kind>(c.backups).fill("backup"),
          ];
          return (
            <div key={rowKey} data-staffing-row={p.name} className="flex items-start gap-2.5">
              <span className="w-27.5 shrink-0 text-sm leading-5.5 text-muted">{p.name}</span>
              <span className="flex flex-wrap gap-1.5">
                {keyedByContent(squares, (k) => k).map(({ key, item: k }) => (
                  <span key={key} data-square={k} className={`size-5.5 rounded-xs ${SQUARE[k]}`} />
                ))}
              </span>
            </div>
          );
        })}
      </div>
      {legend ? <p className="m-0 text-xs text-muted">Solid: filled. Outline: open. Dashed: backup.</p> : null}
    </div>
  );
}
