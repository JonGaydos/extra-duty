import { beforeAll, describe, expect, test } from "vitest";
import { eq } from "drizzle-orm";
import { useApiDb, bearer, call, sessionToken } from "./helpers";
import { setupFixture } from "../assignments/helpers";
import { assignments, jobPositions, jobs, opsPlans, qualifications, userQualifications } from "@/db/schema";
import { POST as submitRoute } from "@/app/api/v1/jobs/[id]/ops-plan/route";

const PDF = Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.alloc(64, 1)]);

describe("POST /jobs/{id}/ops-plan", () => {
  const get = useApiDb();
  let jobId: string;
  const tokens = { ic: "", other: "" };

  beforeAll(async () => {
    const { db } = get();
    const fx = await setupFixture(db, "opsapi");
    const { job } = await fx.mkJob();
    jobId = job.id;
    await db.update(jobs).set({ opsPlanRequired: true }).where(eq(jobs.id, job.id));
    const [spot] = await db.insert(jobPositions).values({ jobId: job.id, positionTypeId: fx.pos["Incident Commander"], count: 1 }).returning();
    const ic = await fx.person();
    const [qual] = await db.select().from(qualifications).where(eq(qualifications.name, "Incident Commander"));
    await db.insert(userQualifications).values({ userId: ic.userId, qualificationId: qual.id });
    await db.insert(assignments).values({ jobId: job.id, jobPositionId: spot.id, userId: ic.userId, status: "signed_up" });
    tokens.ic = await sessionToken(db, ic.userId);
    tokens.other = await sessionToken(db, (await fx.person()).userId);
  });

  async function post(token: string, file: Buffer | null) {
    const form = new FormData();
    if (file) form.set("file", new File([new Uint8Array(file)], "plan.pdf", { type: "application/pdf" }));
    const body = new Response(form);
    const buf = new Uint8Array(await body.arrayBuffer());
    return call(submitRoute, `/api/v1/jobs/${jobId}/ops-plan`, {
      method: "POST",
      headers: { ...bearer(token), "content-type": body.headers.get("content-type")!, "content-length": String(buf.byteLength) },
      body: buf,
      params: { id: jobId },
    });
  }

  test("only the Incident Commander can submit; each upload is a version waiting for review", async () => {
    expect((await post(tokens.other, PDF)).status).toBe(403);
    expect((await post(tokens.ic, null)).status).toBe(400);
    const res = await post(tokens.ic, PDF);
    expect(res.status).toBe(201);
    expect((await res.json()).data).toMatchObject({ decision: "pending" });
    const [plan] = await get().db.select().from(opsPlans).where(eq(opsPlans.jobId, jobId));
    expect(plan.status).toBe("submitted");
  });
});
