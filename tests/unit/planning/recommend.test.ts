import { describe, expect, test } from "vitest";
import { evaluateCaps } from "@/domain/caps/caps";
import { agencyInstant } from "@/domain/time/agency-time";
import { recommendDetails } from "@/domain/planning/recommend";

const at = (m: number, d: number, h: number) => agencyInstant(2026, m, d, h, 0);
const cand = (id: string, d: number, cents: number, startH = 17, endH = 23) => ({ jobPositionId: id, startAt: at(11, d, startH), endAt: at(11, d, endH), totalCents: cents });
const always = () => true;

describe("recommendDetails", () => {
  test("soonest first, skips overlaps, stops once the remaining goal is reached", () => {
    const out = recommendDetails({
      candidates: [cand("nov9", 9, 20000), cand("nov5a", 5, 45000), cand("nov3", 3, 30000), cand("nov5b", 5, 40000, 18, 24)],
      remainingCents: 50000,
      existing: [],
      duty: [],
      capCheck: always,
    });
    expect(out).toEqual(["nov3", "nov5a"]);
  });

  test("keeps going until the goal is met", () => {
    const out = recommendDetails({
      candidates: [cand("a", 3, 10000), cand("b", 4, 10000), cand("c", 5, 10000)],
      remainingCents: 25000,
      existing: [],
      duty: [],
      capCheck: always,
    });
    expect(out).toEqual(["a", "b", "c"]);
  });

  test("nothing is recommended when nothing remains", () => {
    expect(recommendDetails({ candidates: [cand("a", 3, 10000)], remainingCents: 0, existing: [], duty: [], capCheck: always })).toEqual([]);
  });

  test("skips candidates that overlap existing sign-ups or duty time", () => {
    const out = recommendDetails({
      candidates: [cand("a", 3, 10000), cand("b", 4, 10000), cand("c", 5, 10000)],
      remainingCents: 99999,
      existing: [{ startAt: at(11, 3, 16), endAt: at(11, 3, 18) }],
      duty: [{ startAt: at(11, 4, 12), endAt: at(11, 4, 20) }],
      capCheck: always,
    });
    expect(out).toEqual(["c"]);
  });

  test("a flex candidate moves to its best placement around duty time", () => {
    const flex = { earliestStartAt: at(11, 3, 17), latestEndAt: at(11, 4, 0), allowShorter: false };
    const out = recommendDetails({
      candidates: [{ ...cand("a", 3, 10000), flex }],
      remainingCents: 5000,
      existing: [],
      duty: [{ startAt: at(11, 3, 8), endAt: agencyInstant(2026, 11, 3, 17, 45) }],
      capCheck: always,
    });
    expect(out).toEqual(["a"]);
  });

  test("a candidate that would break the rolling 16-hour cap is skipped", () => {
    const season = { id: "s", name: "All", startMonthDay: "01-01", endMonthDay: "12-31", rollingCapMinutes: 960, weekCapMinutes: null, monthCapMinutes: null, createdAt: new Date(), updatedAt: new Date() };
    const held = [{ startAt: at(11, 3, 6), endAt: at(11, 3, 16) }];
    const capCheck = (picked: Array<{ startAt: Date; endAt: Date }>) => {
      const candidate = picked.at(-1)!;
      return evaluateCaps({ existing: [...held, ...picked.slice(0, -1)], candidate, seasons: [season], weekStartsOn: 0, rollingWindowHours: 24 }).every((c) => c.ok);
    };
    const out = recommendDetails({
      candidates: [cand("breaks", 3, 30000, 16, 23), cand("fine", 5, 30000)],
      remainingCents: 50000,
      existing: held,
      duty: [],
      capCheck,
    });
    expect(out).toEqual(["fine"]);
  });
});
