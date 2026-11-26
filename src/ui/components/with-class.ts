/** A base class list with the caller's extra classes appended, when there are any. */
export function withClass(base: string, extra?: string): string {
  return extra ? `${base} ${extra}` : base;
}
