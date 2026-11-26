import { describe, expect, test } from "vitest";
import { demoPassword, randomPassword } from "../../../scripts/demo-password";

describe("the demo accounts' password", () => {
  test("comes from DEMO_PASSWORD when it is set, and prints nothing", () => {
    const lines: string[] = [];
    expect(demoPassword({ DEMO_PASSWORD: "from-the-environment" }, (l) => lines.push(l))).toBe("from-the-environment");
    expect(lines).toEqual([]);
  });

  test("is random for each run when DEMO_PASSWORD is unset or empty, and is printed once", () => {
    for (const env of [{}, { DEMO_PASSWORD: "" }]) {
      const lines: string[] = [];
      const a = demoPassword(env, (l) => lines.push(l));
      expect(a).toMatch(/^[A-Za-z0-9_-]{18}$/);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain(a);
      expect(demoPassword(env, () => {})).not.toBe(a);
    }
  });

  test("random passwords are 18 URL-safe characters and differ each time", () => {
    const seen = new Set(Array.from({ length: 50 }, randomPassword));
    expect(seen.size).toBe(50);
    for (const p of seen) expect(p).toMatch(/^[A-Za-z0-9_-]{18}$/);
  });
});
