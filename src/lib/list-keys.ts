/**
 * React keys for a list whose items have no id. Each key is the item's content (its JSON by default), with a running
 * count in front so repeated content still gets distinct keys: the same item keeps the same key while the list stays
 * the same, unlike a position number that shifts when an item is added or removed above it.
 */
export function keyedByContent<T>(items: readonly T[], content: (item: T) => string = (item) => JSON.stringify(item)): Array<{ key: string; item: T; index: number }> {
  const seen = new Map<string, number>();
  return items.map((item, index) => {
    const text = content(item);
    const n = seen.get(text) ?? 0;
    seen.set(text, n + 1);
    return { key: `${n}:${text}`, item, index };
  });
}

/**
 * Keys for the rows of an editable list (rows with no id that the form changes in place). A row keeps its key while it
 * is the same object, or while it is edited in place (same position, same number of rows); added rows get new keys.
 * `previous` is the last call's rows and keys, kept by the caller between renders.
 */
export function carryRowKeys<T>(rows: readonly T[], previous: { rows: readonly T[]; keys: readonly string[] }, newKey: () => string): string[] {
  // Rows still present claim their own keys first, so a position fallback never takes a key a later row still owns.
  const keys = rows.map((row) => {
    const at = previous.rows.indexOf(row);
    return at >= 0 ? previous.keys[at] : undefined;
  });
  const used = new Set<string>();
  return keys.map((own, i) => {
    let key = own;
    if (key === undefined && rows.length === previous.rows.length && !keys.includes(previous.keys[i])) key = previous.keys[i];
    if (key === undefined || used.has(key)) key = newKey();
    used.add(key);
    return key;
  });
}
