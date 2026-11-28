import { describe, expect, test } from "vitest";
import { signUpState } from "@/app/(app)/jobs/[id]/sign-up-state";

const mine = { label: "Signed up", status: "signed_up", offered: false };

describe("the sign-up panel shows exactly one current state", () => {
  test("signed up", () => {
    expect(signUpState(mine, null)).toEqual({ kind: "signed_up", text: "You are signed up for this detail." });
  });

  test("offered: waiting for someone to take over", () => {
    expect(signUpState({ ...mine, label: "Offered", offered: true }, null)).toEqual({ kind: "offered", text: "Offered: waiting for someone to take over." });
  });

  test("a backup or a pending request names the place", () => {
    expect(signUpState({ label: "Backup #2", status: "backup", offered: false }, null)).toEqual({ kind: "waiting", text: "You are on this detail: Backup #2." });
  });

  test("taken over by someone names them", () => {
    expect(signUpState(null, { status: "canceled", reason: "Taken over by Jordan Example" })).toEqual({ kind: "taken_over", text: "Taken over by Jordan Example. You are no longer on this detail." });
  });

  test("removed", () => {
    expect(signUpState(null, { status: "removed", reason: "Out of uniform" })).toEqual({ kind: "removed", text: "Removed: Out of uniform" });
  });

  test("a live sign-up wins over an older ended one, and nothing at all is no state", () => {
    expect(signUpState(mine, { status: "removed", reason: "Old" }).kind).toBe("signed_up");
    expect(signUpState(null, null)).toEqual({ kind: "none", text: "" });
  });
});
