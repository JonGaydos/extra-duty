/**
 * How a detail is named, with no server code so client components can use it: one sequential number per detail, "#9"
 * or "Detail #9" (see DESIGN.md, Detail numbers).
 */

/** "#9": rows, chips, the calendar and message titles. */
export const detailRef = (n: number) => `#${n}`;
/** "Detail #9": page titles and where a detail is named on its own. */
export const detailName = (n: number) => `Detail #${n}`;
/** "#9 Harbor fireworks": a detail named with its title. */
export const detailTitle = (j: { number: number; title: string }) => `#${j.number} ${j.title}`;

/** "9" or "#9" as a detail number; anything else, including a UUID, is null. */
export function parseDetailNumber(ref: string): number | null {
  const m = /^#?(\d{1,9})$/.exec(ref.trim());
  return m ? Number(m[1]) : null;
}
