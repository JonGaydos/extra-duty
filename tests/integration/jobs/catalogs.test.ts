import { beforeAll, describe, expect, test } from "vitest";
import { eq } from "drizzle-orm";
import { useTestDb } from "../../setup/test-db";
import { makeUser } from "../users/helpers";
import { auditLog, notePresets, qualifications, ranks } from "@/db/schema";
import { seed } from "@/db/seed";
import type { Actor } from "@/domain/actor";
import { ForbiddenError, NotFoundError, ValidationError } from "@/domain/errors";
import {
  createJobType,
  createNotePreset,
  createPaymentMethod,
  createPositionType,
  createVendorType,
  listJobTypes,
  listNotePresets,
  listPaymentMethods,
  listVendorTypes,
  setJobTypeActive,
  setNotePresetActive,
  setPaymentMethodActive,
  setPositionTypeActive,
  setVendorTypeActive,
  updateNotePreset,
  updatePaymentMethod,
  updatePositionType,
  updateVendorType,
  type NotePresetContext,
} from "@/domain/jobs/job-types";

describe("catalogs", () => {
  const get = useTestDb();
  let coord: Actor;
  let deputy: Actor;
  let deputyRank: string;
  let cso: string;
  let motors: string;
  const run = <T>(fn: (tx: Parameters<Parameters<ReturnType<typeof get>["db"]["transaction"]>[0]>[0]) => Promise<T>) =>
    get().db.transaction(fn);
  const posInput = (over: Partial<Parameters<typeof createPositionType>[2]> = {}) => ({
    name: "Motor Escort",
    eligibleRankIds: [deputyRank],
    requiredQualificationIds: [motors],
    isIncidentCommander: false,
    vendorRequestable: false,
    ...over,
  });

  beforeAll(async () => {
    const { db } = get();
    await seed(db);
    coord = (await makeUser(db, "coordinator", "coord@example.test")).actor;
    deputy = (await makeUser(db, "personnel", "dep@example.test")).actor;
    const r = await db.select().from(ranks);
    deputyRank = r.find((x) => x.name === "Deputy Sheriff")!.id;
    cso = r.find((x) => x.name === "CSO")!.id;
    motors = (await db.select().from(qualifications)).find((x) => x.name === "Motors")!.id;
  });

  test("job types: create, duplicate, forbidden, deactivate, audit", async () => {
    const jt = await run((tx) => createJobType(coord, tx, { name: "Parade" }));
    await expect(run((tx) => createJobType(coord, tx, { name: "Parade" }))).rejects.toBeInstanceOf(ValidationError);
    await expect(run((tx) => createJobType(deputy, tx, { name: "Nope" }))).rejects.toBeInstanceOf(ForbiddenError);
    expect((await run((tx) => setJobTypeActive(coord, tx, jt.id, false))).active).toBe(false);
    expect((await run((tx) => listJobTypes(coord, tx))).map((j) => j.name)).toContain("Parade");
    const audits = await get().db.select().from(auditLog).where(eq(auditLog.entityId, jt.id));
    expect(audits.map((a) => a.action)).toEqual(["job_type.create", "job_type.deactivate"]);
  });

  test("vendor types: create, update, deactivate", async () => {
    const vt = await run((tx) => createVendorType(coord, tx, { name: "Church" }));
    const up = await run((tx) => updateVendorType(coord, tx, vt.id, { name: "Place of worship", sortOrder: 5 }));
    expect(up).toMatchObject({ name: "Place of worship", sortOrder: 5 });
    expect((await run((tx) => setVendorTypeActive(coord, tx, vt.id, false))).active).toBe(false);
    expect((await run((tx) => listVendorTypes(coord, tx))).find((v) => v.id === vt.id)?.active).toBe(false);
    await expect(run((tx) => updateVendorType(coord, tx, "missing", { name: "x" }))).rejects.toBeInstanceOf(NotFoundError);
    await expect(run((tx) => createVendorType(deputy, tx, { name: "Nope" }))).rejects.toBeInstanceOf(ForbiddenError);
  });

  test("payment methods: create, update, deactivate", async () => {
    const pm = await run((tx) => createPaymentMethod(coord, tx, { name: "Zelle" }));
    expect(pm.name).toBe("Zelle");
    await expect(run((tx) => createPaymentMethod(coord, tx, { name: "Zelle" }))).rejects.toBeInstanceOf(ValidationError);
    const up = await run((tx) => updatePaymentMethod(coord, tx, pm.id, { name: "Zelle transfer" }));
    expect(up.name).toBe("Zelle transfer");
    expect((await run((tx) => setPaymentMethodActive(coord, tx, pm.id, false))).active).toBe(false);
    const list = await run((tx) => listPaymentMethods(coord, tx));
    expect(list.find((p) => p.id === pm.id)?.active).toBe(false);
    expect(list.map((p) => p.name)).toContain("Check mailed");
    const audits = await get().db.select().from(auditLog).where(eq(auditLog.entityId, pm.id));
    expect(audits.map((a) => a.action)).toEqual(["payment_method.create", "payment_method.update", "payment_method.deactivate"]);
    await expect(run((tx) => createPaymentMethod(deputy, tx, { name: "Nope" }))).rejects.toBeInstanceOf(ForbiddenError);
  });

  test("position types: create, update, deactivate and validation", async () => {
    const pt = await run((tx) => createPositionType(coord, tx, posInput()));
    expect(pt).toMatchObject({ requiredQualificationIds: [motors], eligibleRankIds: [deputyRank], active: true });
    await expect(run((tx) => createPositionType(coord, tx, posInput({ eligibleRankIds: [] })))).rejects.toBeInstanceOf(ValidationError);
    await expect(
      run((tx) => createPositionType(coord, tx, posInput({ name: "A", eligibleRankIds: ["nope"] }))),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      run((tx) => createPositionType(coord, tx, posInput({ name: "B", requiredQualificationIds: ["nope"] }))),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(run((tx) => createPositionType(coord, tx, posInput()))).rejects.toBeInstanceOf(ValidationError);
    await expect(run((tx) => createPositionType(deputy, tx, posInput({ name: "C" })))).rejects.toBeInstanceOf(ForbiddenError);

    const up = await run((tx) =>
      updatePositionType(coord, tx, pt.id, posInput({ eligibleRankIds: [cso, deputyRank], requiredQualificationIds: [], vendorRequestable: true })),
    );
    expect(up).toMatchObject({ eligibleRankIds: [cso, deputyRank], requiredQualificationIds: [], vendorRequestable: true });
    await expect(run((tx) => updatePositionType(coord, tx, pt.id, posInput({ eligibleRankIds: [] })))).rejects.toBeInstanceOf(ValidationError);
    await expect(run((tx) => updatePositionType(coord, tx, "missing", posInput()))).rejects.toBeInstanceOf(NotFoundError);
    expect((await run((tx) => setPositionTypeActive(coord, tx, pt.id, false))).active).toBe(false);
  });

  test("note presets: seeded, create, update, deactivate, invalid context", async () => {
    const seeded = await run((tx) => listNotePresets(coord, tx, "send_back"));
    expect(seeded.length).toBeGreaterThanOrEqual(2);
    const np = await run((tx) => createNotePreset(coord, tx, { context: "issue_note", text: " Spoke with owner " }));
    expect(np.text).toBe("Spoke with owner");
    const up = await run((tx) => updateNotePreset(coord, tx, np.id, { text: "Spoke with the owner", sortOrder: 9 }));
    expect(up).toMatchObject({ text: "Spoke with the owner", sortOrder: 9 });
    expect((await run((tx) => setNotePresetActive(coord, tx, np.id, false))).active).toBe(false);
    await expect(run((tx) => updateNotePreset(coord, tx, np.id, { text: " " }))).rejects.toBeInstanceOf(ValidationError);
    await expect(
      run((tx) => createNotePreset(coord, tx, { context: "bogus" as NotePresetContext, text: "x" })),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(run((tx) => updateNotePreset(coord, tx, "missing", { text: "x" }))).rejects.toBeInstanceOf(NotFoundError);
    await expect(run((tx) => createNotePreset(deputy, tx, { context: "issue_note", text: "x" }))).rejects.toBeInstanceOf(ForbiddenError);
  });

  test("seed is idempotent for note presets", async () => {
    const { db } = get();
    const before = await db.select().from(notePresets);
    await seed(db);
    expect(await db.select().from(notePresets)).toHaveLength(before.length);
    expect(new Set(before.map((p) => p.context)).size).toBe(6);
  });
});
