import type { PendingAck } from "./acknowledgements";

/**
 * What the acknowledgement banner and bar say, and where they open: the oldest waiting message first.
 * One: "Important message from Pat Lee: Radio policy. Read and acknowledge." Several: "3 important messages to read
 * and acknowledge."
 */
export function ackBannerText(pending: readonly PendingAck[]): { title: string; detail: string | null; href: string } | null {
  const first = pending[0];
  if (!first) return null;
  const href = `/messages/${first.messageId}`;
  if (pending.length === 1) return { title: `Important message from ${first.senderName}: ${first.subject}. Read and acknowledge.`, detail: null, href };
  return { title: `${pending.length} important messages to read and acknowledge.`, detail: `Oldest first: ${first.subject}, from ${first.senderName}.`, href };
}
