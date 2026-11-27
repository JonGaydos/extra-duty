import { describe, expect, test } from "vitest";
import { todoLine } from "@/app/(app)/coordinate/_coordinator/todo";

describe("the To-do page summary line", () => {
  test("counts items in To-do words and never says something needs you (owner rule)", () => {
    expect(todoLine(0)).toBe("Your to-do list is clear.");
    expect(todoLine(1)).toBe("To-do: 1 item.");
    expect(todoLine(7)).toBe("To-do: 7 items.");
    for (const n of [0, 1, 7]) expect(todoLine(n)).not.toMatch(/needs? you/i);
  });
});
