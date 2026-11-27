import { describe, expect, test } from "vitest";
import { addPick, audiencesFor, chooseEveryone, chooseRecipients, removePick, START, undoEveryone, type Pick } from "@/app/(app)/messages/new/recipients";

const robin: Pick = { key: "user:c", label: "Robin", audience: { kind: "users", userIds: ["c"] } };
const dale: Pick = { key: "user:d", label: "Dale", audience: { kind: "users", userIds: ["d"] } };
const cso: Pick = { key: "rank:cso", label: "Every CSO", audience: { kind: "rank", rankIds: ["cso"] } };

describe("the message recipient picker", () => {
  test("switching to Everyone clears the chips and keeps them for Undo", () => {
    const picked = [robin, cso].reduce(addPick, START);
    const { state, replaced } = chooseEveryone(picked);
    expect(state).toEqual({ mode: "everyone", picks: [] });
    expect(replaced).toEqual([robin, cso]);
    expect(undoEveryone(replaced)).toEqual({ mode: "choose", picks: [robin, cso] });
  });

  test("the server receives only the Everyone audience in Everyone mode", () => {
    const everyone = chooseEveryone([robin, dale, cso].reduce(addPick, START)).state;
    expect(audiencesFor(everyone)).toEqual([{ kind: "all" }]);
  });

  test("chosen people are merged into one users audience next to the groups; the same pick is added once", () => {
    const s = [robin, cso, dale, robin].reduce(addPick, START);
    expect(s.picks).toEqual([robin, cso, dale]);
    expect(audiencesFor(s)).toEqual([{ kind: "rank", rankIds: ["cso"] }, { kind: "users", userIds: ["c", "d"] }]);
    expect(audiencesFor(removePick(s, "user:c"))).toEqual([{ kind: "rank", rankIds: ["cso"] }, { kind: "users", userIds: ["d"] }]);
  });

  test("going back to Choose recipients from Everyone starts with no chips; adding a chip from Everyone switches mode", () => {
    const everyone = chooseEveryone([robin].reduce(addPick, START)).state;
    expect(chooseRecipients(everyone)).toEqual({ mode: "choose", picks: [] });
    expect(addPick(everyone, dale)).toEqual({ mode: "choose", picks: [dale] });
  });
});
