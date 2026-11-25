import { beforeAll, describe, expect, test } from "vitest";
import { bearer, call, sessionToken, useApiDb } from "./helpers";
import { makeUser } from "../users/helpers";
import { seed } from "@/db/seed";
import { getSettings } from "@/domain/settings/settings";
import { GET, PATCH } from "@/app/api/v1/agency/notifications/route";

describe("/api/v1/agency/notifications", () => {
  const get = useApiDb();
  let coord: string;
  let deputy: string;

  beforeAll(async () => {
    const { db } = get();
    await seed(db);
    coord = await sessionToken(db, (await makeUser(db, "coordinator", "an-coord@example.test")).row.id);
    deputy = await sessionToken(db, (await makeUser(db, "personnel", "an-deputy@example.test")).row.id);
  });

  const patch = (token: string, body: unknown) =>
    call(PATCH, "/api/v1/agency/notifications", { method: "PATCH", headers: { ...bearer(token), "content-type": "application/json" }, body: JSON.stringify(body) });
  const channels = async () => (await get().db.transaction((tx) => getSettings(tx))).notificationChannels;

  test("a coordinator turns a switch off and reads it back", async () => {
    const res = await patch(coord, { channels: { "job.reactivated": { vendor: { email: false } } } });
    expect(res.status, await res.clone().text()).toBe(200);
    expect(await channels()).toEqual({ "job.reactivated": { vendor: { email: false } } });
    const read = await call(GET, "/api/v1/agency/notifications", { headers: bearer(coord) });
    expect(read.status).toBe(200);
    expect((await read.json()).data.channels).toEqual({ "job.reactivated": { vendor: { email: false } } });
  });

  test("a locked type cannot be turned off: 400 and nothing changes", async () => {
    const before = await channels();
    const res = await patch(coord, { channels: { "auth.sign_in_code": { personnel: { email: false } } } });
    expect(res.status).toBe(400);
    expect((await res.json()).error.message).toMatch(/cannot be turned off/);
    expect(await channels()).toEqual(before);
  });

  test("personnel are forbidden", async () => {
    expect((await patch(deputy, { channels: { "job.changed": { personnel: { email: false } } } })).status).toBe(403);
    expect((await call(GET, "/api/v1/agency/notifications", { headers: bearer(deputy) })).status).toBe(403);
  });
});
