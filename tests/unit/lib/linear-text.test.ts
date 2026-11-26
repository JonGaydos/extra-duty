import { describe, expect, test } from "vitest";
import { isEmail } from "@/lib/is-email";
import { trimTrailingSlashes } from "@/lib/text";

/** Runs `fn` and returns how long it took, in milliseconds. */
const timed = (fn: () => unknown) => {
  const start = performance.now();
  fn();
  return performance.now() - start;
};
const HOSTILE = 50_000;

describe("isEmail", () => {
  test("accepts the same addresses as before", () => {
    for (const ok of ["a@b.c", "first.last@example.org", "x+tag@mail.example.co.uk", "a@b..c", "a@.b.c", "o'neil@example.test"]) expect(isEmail(ok), ok).toBe(true);
  });

  test("rejects the same addresses as before", () => {
    for (const bad of ["", "a", "a@b", "@b.c", "a@", "a@.b", "a@b.", "a@@b.c", "a@b@c.d", "a b@c.d", "a@b .c", "a@b.c ", "a\n@b.c", "a@bc."]) expect(isEmail(bad), JSON.stringify(bad)).toBe(false);
  });

  test("rejects anything over 254 characters", () => {
    const local = "a".repeat(64);
    const near = `${local}@${"b".repeat(254 - 64 - 1 - 4)}.com`;
    expect(near).toHaveLength(254);
    expect(isEmail(near)).toBe(true);
    expect(isEmail(`a${near}`)).toBe(false);
  });

  test("answers fast on a long hostile input", () => {
    for (const s of ["a".repeat(HOSTILE), `a@${".".repeat(HOSTILE)}`, "a@b".repeat(HOSTILE / 3), `${"a".repeat(HOSTILE)}@b.c`]) expect(timed(() => isEmail(s))).toBeLessThan(250);
  });
});

describe("trimTrailingSlashes", () => {
  test("drops every trailing slash and nothing else", () => {
    expect(trimTrailingSlashes("https://example.test/")).toBe("https://example.test");
    expect(trimTrailingSlashes("https://example.test///")).toBe("https://example.test");
    expect(trimTrailingSlashes("https://example.test/a/b")).toBe("https://example.test/a/b");
    expect(trimTrailingSlashes("/")).toBe("");
    expect(trimTrailingSlashes("")).toBe("");
  });

  test("answers fast on a long hostile input", () => {
    expect(timed(() => trimTrailingSlashes(`${"/".repeat(HOSTILE)}x`))).toBeLessThan(250);
    expect(timed(() => trimTrailingSlashes(`x${"/".repeat(HOSTILE)}`))).toBeLessThan(250);
  });
});
