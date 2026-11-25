import { expect, test } from "vitest";
import { parseThemeBody } from "@/app/api/v1/me/theme/parse";

test("the theme body accepts day, night or system and nothing else", () => {
  expect(parseThemeBody({ theme: "day" })).toEqual({ theme: "day" });
  expect(parseThemeBody({ theme: "night" })).toEqual({ theme: "night" });
  expect(parseThemeBody({ theme: "system" })).toEqual({ theme: null });
  for (const bad of [{ theme: null }, { theme: "sepia" }, {}, null, "day", { theme: 1 }]) {
    expect(parseThemeBody(bad)).toBeNull();
  }
});
