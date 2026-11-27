import type { Audience } from "@/domain/messages/messages";

/** One recipient chip: a person, a rank, a detail's roster or the coordinators. */
export type Pick = { key: string; label: string; audience: Audience };

/**
 * The "Send to" choice: Everyone, or the chips chosen. The two never mix, so a chip can never stay listed beside
 * Everyone (owner bug report 2026-11-27).
 */
export type ToState = { mode: "everyone" | "choose"; picks: Pick[] };

export const START: ToState = { mode: "choose", picks: [] };

/** Adds a chip once; adding one while Everyone is chosen switches to Choose recipients. */
export function addPick(s: ToState, pick: Pick): ToState {
  if (s.mode === "choose" && s.picks.some((x) => x.key === pick.key)) return s;
  return { mode: "choose", picks: [...(s.mode === "choose" ? s.picks : []), pick] };
}

export function removePick(s: ToState, key: string): ToState {
  return { ...s, picks: s.picks.filter((x) => x.key !== key) };
}

/** Everyone replaces the chips. They come back with Undo (see undoEveryone). */
export function chooseEveryone(s: ToState): { state: ToState; replaced: Pick[] } {
  return { state: { mode: "everyone", picks: [] }, replaced: s.mode === "choose" ? s.picks : [] };
}

export function undoEveryone(replaced: Pick[]): ToState {
  return { mode: "choose", picks: replaced };
}

export function chooseRecipients(s: ToState): ToState {
  return s.mode === "choose" ? s : START;
}

/**
 * What the server gets: only `all` for Everyone; otherwise each group chip, with every person picked by name merged
 * into one `users` audience. The server sends one copy per person however many chips cover them.
 */
export function audiencesFor(s: ToState): Audience[] {
  if (s.mode === "everyone") return [{ kind: "all" }];
  const users = s.picks.flatMap((x) => (x.audience.kind === "users" ? x.audience.userIds : []));
  const rest = s.picks.filter((x) => x.audience.kind !== "users").map((x) => x.audience);
  return users.length ? [...rest, { kind: "users", userIds: users }] : rest;
}
