/** Compare strings by code unit, like the default sort, for an explicit sort order that ignores locale. */
export const byText = (a: string, b: string): number => {
  if (a < b) return -1;
  return a > b ? 1 : 0;
};

/** Compare numbers in ascending order. */
export const byNumber = (a: number, b: number): number => a - b;
