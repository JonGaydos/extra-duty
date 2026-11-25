/** "12 minutes", "1 minute" or "40 seconds": a wait in words, rounded up. Shared by the server and the sign-in pages. */
export function waitText(ms: number): string {
  if (ms < 60_000) {
    const s = Math.max(1, Math.ceil(ms / 1000));
    return `${s} ${s === 1 ? "second" : "seconds"}`;
  }
  const m = Math.ceil(ms / 60_000);
  return `${m} ${m === 1 ? "minute" : "minutes"}`;
}
