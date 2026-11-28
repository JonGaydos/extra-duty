/** The prefix the domain stores on a sign-up someone took over ("Taken over by Jordan Example"). */
const TAKEN_OVER = "Taken over by ";

export type SignUpStateKind = "signed_up" | "offered" | "waiting" | "taken_over" | "removed" | "canceled" | "none";

/**
 * The one current state the sign-up panel shows for the person, from the server's data after each action: signed
 * up, offered (waiting for someone to take over), a backup or pending place, taken over, removed or canceled.
 */
export function signUpState(
  mine: { label: string; status: string; offered: boolean } | null,
  ended: { status: string; reason: string | null } | null,
): { kind: SignUpStateKind; text: string } {
  if (mine) {
    if (mine.offered) return { kind: "offered", text: "Offered: waiting for someone to take over." };
    if (mine.status === "signed_up") return { kind: "signed_up", text: "You are signed up for this detail." };
    return { kind: "waiting", text: `You are on this detail: ${mine.label}.` };
  }
  if (!ended) return { kind: "none", text: "" };
  if (ended.reason?.startsWith(TAKEN_OVER)) return { kind: "taken_over", text: `${ended.reason}. You are no longer on this detail.` };
  if (ended.status === "removed") return { kind: "removed", text: ended.reason ? `Removed: ${ended.reason}` : "Removed from this detail." };
  return { kind: "canceled", text: ended.reason ?? "Your sign-up was canceled." };
}
