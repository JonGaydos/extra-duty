import { beforeAll, describe, expect, test } from "vitest";
import { useTestDb } from "../../setup/test-db";
import { makeUser } from "../users/helpers";
import { seasons } from "@/db/schema";
import { seed } from "@/db/seed";
import type { Actor } from "@/domain/actor";
import { ForbiddenError, RuleViolation, ValidationError } from "@/domain/errors";
import { agencyInstant } from "@/domain/time/agency-time";
import { createSeason, deleteSeason, seasonFor, updateSeason } from "@/domain/caps/seasons";

const caps = { rollingCapMinutes: 960, weekCapMinutes: null, monthCapMinutes: null };

describe("seasons", () => {
  const get = useTestDb();
  let coord: Actor;
  let deputy: Actor;

  beforeAll(async () => {
    const { db } = get();
    await seed(db);
    await db.delete(seasons);
    coord = (await makeUser(db, "coordinator", "coord@example.test")).actor;
    deputy = (await makeUser(db, "personnel", "dep@example.test")).actor;
  });

  test("seasonFor handles a wrapping season, agency dates and gaps", async () => {
    const { db } = get();
    const summer = await db.transaction((tx) =>
      createSeason(coord, tx, { name: "Summer", startMonthDay: "05-01", endMonthDay: "09-30", ...caps }),
    );
    const off = await db.transaction((tx) =>
      createSeason(coord, tx, { name: "Off season", startMonthDay: "10-01", endMonthDay: "04-30", ...caps }),
    );
    const all = [summer, off];
    expect(seasonFor(new Date("2026-07-04T17:00:00Z"), all)?.name).toBe("Summer");
    expect(seasonFor(new Date("2026-01-15T17:00:00Z"), all)?.name).toBe("Off season");
    expect(seasonFor(new Date("2026-12-31T12:00:00Z"), all)?.name).toBe("Off season");
    // 00:30 UTC on May 1 is still April 30 in agency time.
    expect(seasonFor(new Date("2026-05-01T00:30:00Z"), all)?.name).toBe("Off season");
    expect(seasonFor(agencyInstant(2026, 5, 1, 0, 30), all)?.name).toBe("Summer");
    // A date covered by no season returns null: no caps.
    expect(seasonFor(new Date("2026-07-04T17:00:00Z"), [off])).toBeNull();
    await db.transaction((tx) => deleteSeason(coord, tx, summer.id));
    await db.transaction((tx) => deleteSeason(coord, tx, off.id));
    expect(await db.select().from(seasons)).toHaveLength(0);
  });

  test("overlapping seasons are rejected on create and update; personnel are refused", async () => {
    const { db } = get();
    const a = await db.transaction((tx) =>
      createSeason(coord, tx, { name: "Winter", startMonthDay: "11-01", endMonthDay: "02-28", ...caps }),
    );
    await expect(
      db.transaction((tx) => createSeason(coord, tx, { name: "Jan", startMonthDay: "01-10", endMonthDay: "01-20", ...caps })),
    ).rejects.toBeInstanceOf(RuleViolation);
    await expect(
      db.transaction((tx) => createSeason(coord, tx, { name: "Dec", startMonthDay: "12-30", endMonthDay: "01-02", ...caps })),
    ).rejects.toBeInstanceOf(RuleViolation);
    const b = await db.transaction((tx) =>
      createSeason(coord, tx, { name: "Spring", startMonthDay: "03-01", endMonthDay: "04-30", ...caps }),
    );
    await expect(
      db.transaction((tx) => updateSeason(coord, tx, b.id, { ...b, startMonthDay: "02-01" })),
    ).rejects.toBeInstanceOf(RuleViolation);
    const ok = await db.transaction((tx) => updateSeason(coord, tx, b.id, { ...b, weekCapMinutes: 1200 }));
    expect(ok.weekCapMinutes).toBe(1200);
    await expect(
      db.transaction((tx) => createSeason(deputy, tx, { name: "X", startMonthDay: "06-01", endMonthDay: "06-02", ...caps })),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      db.transaction((tx) => createSeason(coord, tx, { name: "Bad", startMonthDay: "13-01", endMonthDay: "06-02", ...caps })),
    ).rejects.toBeInstanceOf(ValidationError);
    await db.transaction((tx) => deleteSeason(coord, tx, a.id));
    await db.transaction((tx) => deleteSeason(coord, tx, b.id));
  });
});
