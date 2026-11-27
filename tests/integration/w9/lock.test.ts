import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, test } from "vitest";
import { eq } from "drizzle-orm";
import { useTestDb } from "../../setup/test-db";
import { useEmailQueue } from "../../setup/email-queue";
import { setupFixture } from "../assignments/helpers";
import { assignments, w9s } from "@/db/schema";
import { assignPerson } from "@/domain/assignments/coordinator";
import { signUp } from "@/domain/assignments/signup";
import { RuleViolation } from "@/domain/errors";
import { readW9Lock } from "@/domain/w9/requests";
import { reviewW9, uploadW9 } from "@/domain/w9/w9";
import { createLocalStorage } from "@/lib/storage/local";
import type { Storage } from "@/lib/storage";
import { giveApprovedW9 } from "./helpers";

const PDF = Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.from("w9 body ".repeat(20))]);

describe("the W-9 sign-up lock", () => {
  const get = useTestDb();
  useEmailQueue(get);
  let f: Awaited<ReturnType<typeof setupFixture>>;
  let storage: Storage;

  beforeAll(async () => {
    f = await setupFixture(get().db, "w9lock");
    storage = createLocalStorage(await mkdtemp(join(tmpdir(), "extra-duty-w9-lock-")));
  });

  const failed = async (p: Promise<unknown>) => {
    const err = await p.then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(RuleViolation);
    return (err as RuleViolation).checks.filter((c) => !c.ok);
  };

  test("no W-9 on file: sign-up is refused with a plain message", async () => {
    const me = await f.person("Deputy Sheriff", { w9: false });
    const { job, positionId } = await f.mkJob();
    const checks = await failed(f.run((tx) => signUp(me, tx, positionId, { warningVersion: 1, jobId: job.id })));
    expect(checks.map((c) => c.check)).toEqual(["w9"]);
    expect(checks[0].message).toMatch(/W-9 needs to be approved before you can sign up/);
  });

  test("a pending W-9 still locks; once approved the person can sign up", async () => {
    const me = await f.person("Deputy Sheriff", { w9: false });
    const { job, positionId } = await f.mkJob();
    const row = await f.run((tx) => uploadW9(me, tx, PDF, "w9.pdf", storage));
    const checks = await failed(f.run((tx) => signUp(me, tx, positionId, { warningVersion: 1, jobId: job.id })));
    expect(checks[0].message).toBe("Your W-9 needs to be approved before you can sign up");
    await f.run((tx) => reviewW9(f.coord, tx, row.id, { decision: "approve", signedOn: "2026-01-10", formRevision: "March 2024" }));
    const a = await f.run((tx) => signUp(me, tx, positionId, { warningVersion: 1, jobId: job.id }));
    expect(a.status).toBe("signed_up");
  });

  test("a rejected W-9 with no approved one says to upload a new one", async () => {
    const me = await f.person("Deputy Sheriff", { w9: false });
    const row = await f.run((tx) => uploadW9(me, tx, PDF, "w9.pdf", storage));
    await f.run((tx) => reviewW9(f.coord, tx, row.id, { decision: "reject", reason: "Not signed" }));
    const lock = await f.run((tx) => readW9Lock(tx, me.userId, new Date()));
    expect(lock).toEqual({ locked: true, message: "Your W-9 was not approved. Upload a new one in Profile to sign up" });
  });

  test("the lock is sign-ups only: a coordinator can still assign with an override reason", async () => {
    const me = await f.person("Deputy Sheriff", { w9: false });
    const { positionId } = await f.mkJob();
    const checks = await failed(f.run((tx) => assignPerson(f.coord, tx, positionId, me.userId, { notify: false })));
    expect(checks.map((c) => c.check)).toEqual(["w9"]);
    const a = await f.run((tx) => assignPerson(f.coord, tx, positionId, me.userId, { notify: false, overrideReason: "Paper W-9 in the office" }));
    expect(a.overrideReason).toBe("Paper W-9 in the office");
    expect((await get().db.select().from(assignments).where(eq(assignments.id, a.id)))[0].status).toBe("signed_up");
  });

  test("an approved W-9 passes, even with a newer upload waiting for review", async () => {
    const me = await f.person("Deputy Sheriff", { w9: false });
    await giveApprovedW9(get().db, me.userId);
    await f.run((tx) => uploadW9(me, tx, PDF, "w9.pdf", storage));
    expect((await get().db.select().from(w9s).where(eq(w9s.userId, me.userId))).map((r) => r.status).sort((a, b) => a.localeCompare(b))).toEqual(["approved", "pending"]);
    expect(await f.run((tx) => readW9Lock(tx, me.userId, new Date()))).toEqual({ locked: false, message: "" });
  });
});
