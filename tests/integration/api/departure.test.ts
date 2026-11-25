import { beforeAll, describe, expect, test } from "vitest";
import { eq } from "drizzle-orm";
import { bearer, call, useApiDb } from "./helpers";
import { makeUser } from "../users/helpers";
import { setupFixture } from "../assignments/helpers";
import { assignments, users } from "@/db/schema";
import type { Actor } from "@/domain/actor";
import { createApiKey } from "@/domain/api-keys/api-keys";
import { agencyDayKey } from "@/domain/time/agency-time";
import { POST as deactivate } from "@/app/api/v1/users/[id]/deactivate/route";
import { GET as preview } from "@/app/api/v1/users/[id]/deactivate/preview/route";
import { POST as reactivate } from "@/app/api/v1/users/[id]/reactivate/route";
import { routes } from "@/lib/api/registry";

describe("departure API: preview, deactivate and reactivate", () => {
  const get = useApiDb();
  let admin: Actor;
  let f: Awaited<ReturnType<typeof setupFixture>>;
  let person: Actor;
  let rowId: string;
  const today = agencyDayKey(new Date());

  beforeAll(async () => {
    f = await setupFixture(get().db, "dep-api");
    admin = (await makeUser(get().db, "admin", "dep-api-admin@example.test")).actor;
    person = await f.person();
    const { job, positionId } = await f.mkJob();
    rowId = (await get().db.insert(assignments).values({ jobId: job.id, jobPositionId: positionId, userId: person.userId, status: "signed_up" }).returning())[0].id;
  });

  const key = async (scopes: Array<"read" | "write">) => (await get().db.transaction((tx) => createApiKey(admin, tx, { name: `Departure ${scopes.join("+")}`, scopes }))).key;
  const post = (handler: typeof deactivate, path: string, token: string, id: string, body: unknown) =>
    call(handler, path, { method: "POST", headers: { ...bearer(token), "content-type": "application/json" }, body: JSON.stringify(body), params: { id } });

  test("the routes are registered", () => {
    expect(routes["GET /users/{id}/deactivate/preview"]).toBeDefined();
    expect(routes["POST /users/{id}/deactivate"].body).toBeDefined();
    expect(routes["POST /users/{id}/reactivate"].body).toBeDefined();
  });

  test("a read key can preview the checklist but cannot deactivate", async () => {
    const token = await key(["read"]);
    const res = await call(preview, `/api/v1/users/${person.userId}/deactivate/preview?lastDay=${today}`, { headers: bearer(token), params: { id: person.userId } });
    expect(res.status, await res.clone().text()).toBe(200);
    const data = (await res.json()).data;
    expect(data.upcoming.map((u: { assignmentId: string }) => u.assignmentId)).toEqual([rowId]);
    expect(data).toMatchObject({ unbilled: [], unpaid: [] });
    expect((await post(deactivate, `/api/v1/users/${person.userId}/deactivate`, token, person.userId, { reason: "Left", lastDay: today })).status).toBe(403);
    expect((await get().db.select().from(users).where(eq(users.id, person.userId)))[0].active).toBe(true);
  });

  test("a write key deactivates with a reason and last day, gets the removals and lists, then reactivates", async () => {
    const token = await key(["write"]);
    const path = `/api/v1/users/${person.userId}/deactivate`;
    expect((await post(deactivate, path, token, person.userId, { reason: "Left" })).status).toBe(400);
    expect((await post(deactivate, path, token, person.userId, { reason: " ", lastDay: today })).status).toBe(400);
    expect((await post(deactivate, path, token, person.userId, { reason: "Left", lastDay: "2999-01-01" })).status).toBe(400);
    const res = await post(deactivate, path, token, person.userId, { reason: "Took another job", lastDay: today });
    expect(res.status, await res.clone().text()).toBe(200);
    const data = (await res.json()).data;
    expect(data.user).toMatchObject({ id: person.userId, active: false, lastDay: today });
    expect(data.removed.map((r: { assignmentId: string }) => r.assignmentId)).toEqual([rowId]);
    expect(data).toMatchObject({ unbilled: [], unpaid: [] });

    const rpath = `/api/v1/users/${person.userId}/reactivate`;
    expect((await post(reactivate, rpath, await key(["read"]), person.userId, { reason: "Back" })).status).toBe(403);
    expect((await post(reactivate, rpath, token, person.userId, {})).status).toBe(400);
    const back = await post(reactivate, rpath, token, person.userId, { reason: "Rehired" });
    expect(back.status, await back.clone().text()).toBe(200);
    expect((await back.json()).data).toMatchObject({ id: person.userId, active: true });
  });

  test("a personnel session is refused by policy", async () => {
    const { sessionToken } = await import("./helpers");
    const token = await sessionToken(get().db, person.userId);
    const res = await call(preview, `/api/v1/users/${admin.userId}/deactivate/preview?lastDay=${today}`, { headers: bearer(token), params: { id: admin.userId } });
    expect(res.status).toBe(403);
  });
});
