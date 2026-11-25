import { beforeAll, describe, expect, test } from "vitest";
import { eq } from "drizzle-orm";
import { bearer, call, useApiDb } from "./helpers";
import { makeUser } from "../users/helpers";
import { setupFixture } from "../assignments/helpers";
import { jobs } from "@/db/schema";
import type { Actor } from "@/domain/actor";
import { createApiKey } from "@/domain/api-keys/api-keys";
import { cancelJob } from "@/domain/jobs/jobs";
import { POST as reactivate } from "@/app/api/v1/jobs/[id]/reactivate/route";

describe("POST /api/v1/jobs/{id}/reactivate", () => {
  const get = useApiDb();
  let admin: Actor;
  let f: Awaited<ReturnType<typeof setupFixture>>;

  beforeAll(async () => {
    f = await setupFixture(get().db, "rx-api");
    admin = (await makeUser(get().db, "admin", "rx-api-admin@example.test")).actor;
  });

  const key = async (scopes: Array<"read" | "write">) => (await get().db.transaction((tx) => createApiKey(admin, tx, { name: `Reactivate ${scopes.join("+")}`, scopes }))).key;
  const post = (token: string, id: string, body: unknown) =>
    call(reactivate, `/api/v1/jobs/${id}/reactivate`, { method: "POST", headers: { ...bearer(token), "content-type": "application/json" }, body: JSON.stringify(body), params: { id } });
  const canceled = async () => {
    const { job } = await f.mkJob();
    await f.run((tx) => cancelJob(f.coord, tx, job.id, "Wrong date"));
    return job;
  };
  const state = async (id: string) => (await get().db.select().from(jobs).where(eq(jobs.id, id)))[0].state;

  test("a write key reactivates the detail; a missing reason is 400", async () => {
    const job = await canceled();
    const token = await key(["write"]);
    expect((await post(token, job.id, { reason: " " })).status).toBe(400);
    const res = await post(token, job.id, { reason: "Vendor going ahead" });
    expect(res.status, await res.clone().text()).toBe(200);
    expect((await res.json()).data).toMatchObject({ id: job.id, state: "scheduled" });
    expect(await state(job.id)).toBe("scheduled");
  });

  test("a read key gets 403 and the detail stays canceled", async () => {
    const job = await canceled();
    const res = await post(await key(["read"]), job.id, { reason: "Vendor going ahead" });
    expect(res.status).toBe(403);
    expect(await state(job.id)).toBe("canceled");
  });
});
