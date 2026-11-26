import { useRef } from "react";
import { carryRowKeys } from "@/lib/list-keys";

/**
 * Stable keys for the rows of an editable list with no ids (positions, addresses of concern), so a removed row takes
 * its own field state with it instead of passing it to the row below.
 */
export function useRowKeys<T>(rows: readonly T[]): string[] {
  const last = useRef<{ rows: readonly T[]; keys: string[] }>({ rows: [], keys: [] });
  const made = useRef(0);
  if (last.current.rows !== rows) last.current = { rows, keys: carryRowKeys(rows, last.current, () => `row-${++made.current}`) };
  return last.current.keys;
}
