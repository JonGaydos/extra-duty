import { Icon } from "../icons";

export type CheckItem = {
  label: string;
  ok: boolean;
  /** Right-aligned fact, such as "8 / 16 h". */
  detail?: string;
};

/** Rules and whether each is met (sign-up checks, caps). State is in words for screen readers, not only the icon. */
export function CheckList({ items }: { items: CheckItem[] }) {
  return (
    <ul className="m-0 flex list-none flex-col gap-2.25 p-0 text-body">
      {items.map((c) => (
        <li key={c.label} className="flex items-center gap-2.5">
          <Icon
            name={c.ok ? "check" : "cross"}
            size={18}
            strokeWidth={2.2}
            className={`shrink-0 ${c.ok ? "text-success-ink" : "text-danger-ink"}`}
          />
          <span className="sr-only">{c.ok ? "Met: " : "Not met: "}</span>
          <span className={`flex-1 ${c.ok ? "" : "font-medium text-danger-ink"}`}>{c.label}</span>
          {c.detail ? (
            <span className="text-muted" data-numeric>
              {c.detail}
            </span>
          ) : null}
        </li>
      ))}
    </ul>
  );
}
