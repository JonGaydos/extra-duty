import type { ReactNode } from "react";
import { ScrollRegion } from "./ScrollRegion";

export type Column<T> = {
  header: string;
  cell: (row: T) => ReactNode;
  /** Numbers and money align to the end. */
  align?: "start" | "end";
};

/**
 * A data table on a card. Wide tables scroll sideways inside the card (and
 * only then become a focusable region, so keyboard users can scroll them);
 * the page never does.
 */
export function Table<T>({
  caption,
  hideCaption = false,
  columns,
  rows,
  rowKey,
  empty = "Nothing to show.",
}: {
  caption: string;
  hideCaption?: boolean;
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  empty?: ReactNode;
}) {
  const align = (c: Column<T>) => (c.align === "end" ? "text-right" : "text-left");
  return (
    <ScrollRegion label={caption} className="overflow-x-auto rounded-xl border border-line bg-surface md:rounded-2xl">
      <table className="w-full border-collapse text-body">
        <caption className={hideCaption ? "sr-only" : "px-4 pt-4 pb-1 text-left text-title font-semibold md:text-base"}>
          {caption}
        </caption>
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c.header} scope="col" className={`px-3.5 py-2.5 text-xs font-semibold text-muted ${align(c)}`}>
                {c.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr className="border-t border-divider">
              <td colSpan={columns.length} className="px-3.5 py-6 text-center text-muted">
                {empty}
              </td>
            </tr>
          ) : (
            rows.map((r) => (
              <tr key={rowKey(r)} className="border-t border-divider">
                {columns.map((c) => (
                  <td key={c.header} className={`px-3.5 py-3 align-top ${align(c)}`}>
                    {c.cell(r)}
                  </td>
                ))}
              </tr>
            ))
          )}
        </tbody>
      </table>
    </ScrollRegion>
  );
}
