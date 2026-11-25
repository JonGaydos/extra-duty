/**
 * A datetime-local value ("YYYY-MM-DDTHH:mm") moved later by `minutes`, rolling into the next day (or year) when
 * it passes midnight. Wall-clock arithmetic only, so the time zone never matters.
 */
export function laterLocalInput(value: string, minutes: number): string {
  const t = new Date(`${value}:00Z`);
  return new Date(t.getTime() + minutes * 60_000).toISOString().slice(0, 16);
}
