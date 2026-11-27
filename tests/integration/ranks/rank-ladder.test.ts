import { describe, expect, test } from "vitest";
import { and, eq } from "drizzle-orm";
import { useTestDb } from "../../setup/test-db";
import { auditLog, positionTypes, ranks } from "@/db/schema";
import { loadPosition } from "@/domain/assignments/signup";
import { RuleViolation, ValidationError } from "@/domain/errors";
import { createPositionType, deletePositionType, positionTypeUsage } from "@/domain/jobs/job-types";
import { applyRankChange, deleteRank, ladderHighestFirst, listRanks, previewRankChange, rankUsage, renameRank } from "@/domain/ranks/ranks";
import { agencyInstant } from "@/domain/time/agency-time";
import { setupFixture } from "../assignments/helpers";

const NOW = agencyInstant(2035, 1, 1, 12, 0);

describe("the rank ladder", () => {
  const get = useTestDb();

  const names = (ids: string[], byId: Record<string, string>) => ids.map((id) => byId[id]).sort((a, b) => a.localeCompare(b));

  test("moving a rank keeps higher ranks filling lower spots, previews the details it touches, and is audited", async () => {
    const f = await setupFixture(get().db, "ladder1");
    const { positionId } = await f.mkJob();
    const byId = Object.fromEntries(Object.entries(f.rank).map(([n, id]) => [id, n]));
    const listOf = async (name: string) => names((await get().db.select().from(positionTypes).where(eq(positionTypes.name, name)))[0].eligibleRankIds, byId);

    const preview = await f.run((tx) => previewRankChange(f.coord, tx, { kind: "move", id: f.rank.CSO, direction: "higher" }, NOW));
    const deputy = preview.find((p) => p.name === "Deputy Sheriff");
    expect(deputy).toMatchObject({ added: ["CSO"], removed: [], upcomingDetails: 1 });
    expect(preview.find((p) => p.name === "CSO")).toMatchObject({ added: [], removed: ["Deputy Sheriff"] });

    await f.run((tx) => applyRankChange(f.coord, tx, { kind: "move", id: f.rank.CSO, direction: "higher" }, NOW));
    expect(ladderHighestFirst(await f.run(listRanks)).map((r) => r.name)).toEqual(["CSO", "Deputy Sheriff", "Posse"]);
    expect(await listOf("Posse")).toEqual(["CSO", "Deputy Sheriff", "Posse"]);
    expect(await listOf("CSO")).toEqual(["CSO"]);
    expect(await listOf("Deputy Sheriff")).toEqual(["CSO", "Deputy Sheriff"]);
    expect(await listOf("Dispatcher")).toEqual(["Dispatcher"]);
    // The posted detail's Deputy Sheriff spot now takes a CSO.
    expect((await f.run((tx) => loadPosition(tx, positionId))).eligibleRankIds).toContain(f.rank.CSO);

    const audits = await get().db.select().from(auditLog).where(eq(auditLog.reason, "Rank ladder changed"));
    expect(audits.map((a) => a.action)).toContain("position_type.update");
    const moves = await get().db.select().from(auditLog).where(and(eq(auditLog.action, "rank.reorder"), eq(auditLog.entityId, f.rank.CSO)));
    expect(moves).toHaveLength(1);

    await f.run((tx) => applyRankChange(f.coord, tx, { kind: "move", id: f.rank.CSO, direction: "lower" }, NOW));
    expect(await listOf("CSO")).toEqual(["CSO", "Deputy Sheriff"]);
    expect(await listOf("Deputy Sheriff")).toEqual(["Deputy Sheriff"]);
  });

  test("a rank taken outside the ladder fills only its own spots, and comes back where it is put", async () => {
    const f = await setupFixture(get().db, "ladder2");
    const byId = Object.fromEntries(Object.entries(f.rank).map(([n, id]) => [id, n]));
    const listOf = async (name: string) => names((await get().db.select().from(positionTypes).where(eq(positionTypes.name, name)))[0].eligibleRankIds, byId);

    await f.run((tx) => applyRankChange(f.coord, tx, { kind: "ladder", id: f.rank.CSO, inLadder: false }, NOW));
    expect(await listOf("Posse")).toEqual(["Deputy Sheriff", "Posse"]);
    expect(await listOf("CSO")).toEqual(["CSO"]);
    expect(await listOf("Incident Commander")).toEqual(["Deputy Sheriff", "Posse"]);
    const [cso] = await get().db.select().from(ranks).where(eq(ranks.id, f.rank.CSO));
    expect(cso.inLadder).toBe(false);
    expect(await get().db.select().from(auditLog).where(and(eq(auditLog.action, "rank.ladder"), eq(auditLog.entityId, f.rank.CSO)))).toHaveLength(1);

    await f.run((tx) => applyRankChange(f.coord, tx, { kind: "ladder", id: f.rank.CSO, inLadder: true, place: 2 }, NOW));
    expect(ladderHighestFirst(await f.run(listRanks)).map((r) => r.name)).toEqual(["Deputy Sheriff", "CSO", "Posse"]);
    expect(await listOf("Posse")).toEqual(["CSO", "Deputy Sheriff", "Posse"]);
    expect(await listOf("CSO")).toEqual(["CSO", "Deputy Sheriff"]);
  });

  test("renaming and adding a rank are audited; names stay unique", async () => {
    const f = await setupFixture(get().db, "ladder3");
    await f.run((tx) => renameRank(f.coord, tx, f.rank.Posse, "Reserve"));
    expect(await get().db.select().from(auditLog).where(and(eq(auditLog.action, "rank.rename"), eq(auditLog.entityId, f.rank.Posse)))).toHaveLength(1);
    await expect(f.run((tx) => renameRank(f.coord, tx, f.rank.Posse, "cso"))).rejects.toBeInstanceOf(ValidationError);

    const { rank } = await f.run((tx) => applyRankChange(f.coord, tx, { kind: "create", name: "Sergeant", inLadder: true, place: 1 }, NOW));
    expect(ladderHighestFirst(await f.run(listRanks))[0].name).toBe("Sergeant");
    expect(await get().db.select().from(auditLog).where(and(eq(auditLog.action, "rank.create"), eq(auditLog.entityId, rank!.id)))).toHaveLength(1);
    // Highest now: it fills every ladder spot.
    const [deputyPos] = await get().db.select().from(positionTypes).where(eq(positionTypes.name, "Deputy Sheriff"));
    expect(deputyPos.eligibleRankIds).toContain(rank!.id);

    const { rank: outside } = await f.run((tx) => applyRankChange(f.coord, tx, { kind: "create", name: "Chaplain", inLadder: false }, NOW));
    expect(outside!.inLadder).toBe(false);
    await f.run((tx) => renameRank(f.coord, tx, f.rank.Posse, "Posse"));
  });

  test("delete is refused for a used rank and allowed for one added by mistake", async () => {
    const f = await setupFixture(get().db, "ladder4");
    await f.person("Deputy Sheriff");
    await expect(f.run((tx) => deleteRank(f.coord, tx, f.rank["Deputy Sheriff"]))).rejects.toBeInstanceOf(RuleViolation);
    expect((await f.run((tx) => rankUsage(tx, f.rank["Deputy Sheriff"]))).reason).toMatch(/^Used by \d+ (person|people)$/);
    // Dispatcher fills its own position type: used.
    expect((await f.run((tx) => rankUsage(tx, f.rank.Dispatcher))).reason).toBe("Used by 1 position type");

    const { rank: oops } = await f.run((tx) => applyRankChange(f.coord, tx, { kind: "create", name: "Typo rank", inLadder: true, place: 1 }, NOW));
    expect((await f.run((tx) => rankUsage(tx, oops!.id))).reason).toBeNull();
    await f.run((tx) => deleteRank(f.coord, tx, oops!.id));
    expect(await get().db.select().from(ranks).where(eq(ranks.id, oops!.id))).toHaveLength(0);
    const [deputyPos] = await get().db.select().from(positionTypes).where(eq(positionTypes.name, "Deputy Sheriff"));
    expect(deputyPos.eligibleRankIds).not.toContain(oops!.id);
    expect(await get().db.select().from(auditLog).where(and(eq(auditLog.action, "rank.delete"), eq(auditLog.entityId, oops!.id)))).toHaveLength(1);

    // A rank once given to someone is a past record even after they move on.
    const { rank: past } = await f.run((tx) => applyRankChange(f.coord, tx, { kind: "create", name: "Former", inLadder: false }, NOW));
    await get().db.insert(auditLog).values({ action: "user.update", entityType: "user", entityId: "u1", before: { rankId: past!.id }, after: { rankId: null } });
    expect((await f.run((tx) => rankUsage(tx, past!.id))).reason).toBe("Used in past records");
    await expect(f.run((tx) => deleteRank(f.coord, tx, past!.id))).rejects.toBeInstanceOf(RuleViolation);
  });

  test("position types: delete only one no detail or record has used", async () => {
    const f = await setupFixture(get().db, "ladder5");
    await f.mkJob();
    expect((await f.run((tx) => positionTypeUsage(tx, f.pos["Deputy Sheriff"]))).reason).toMatch(/^Used on \d+ details?$/);
    await expect(f.run((tx) => deletePositionType(f.coord, tx, f.pos["Deputy Sheriff"]))).rejects.toBeInstanceOf(RuleViolation);

    const added = await f.run((tx) => createPositionType(f.coord, tx, { name: "Typo position", eligibleRankIds: [f.rank.Posse], requiredQualificationIds: [], isIncidentCommander: false, vendorRequestable: false }));
    expect((await f.run((tx) => positionTypeUsage(tx, added.id))).reason).toBeNull();
    await f.run((tx) => deletePositionType(f.coord, tx, added.id));
    expect(await get().db.select().from(positionTypes).where(eq(positionTypes.id, added.id))).toHaveLength(0);
    expect(await get().db.select().from(auditLog).where(and(eq(auditLog.action, "position_type.delete"), eq(auditLog.entityId, added.id)))).toHaveLength(1);
  });
});
