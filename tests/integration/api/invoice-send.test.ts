import { beforeAll, describe, expect, test } from "vitest";
import { eq } from "drizzle-orm";
import { bearer, call, useApiDb } from "./helpers";
import { makeUser } from "../users/helpers";
import { setupFixture } from "../assignments/helpers";
import { assignments, invoices, users, vendors } from "@/db/schema";
import type { Actor } from "@/domain/actor";
import { createApiKey } from "@/domain/api-keys/api-keys";
import { billAssignment } from "@/domain/billing/bill";
import { updateSettings } from "@/domain/settings/settings";
import { agencyInstant } from "@/domain/time/agency-time";
import { POST as approve } from "@/app/api/v1/invoices/[id]/approve/route";
import { POST as send } from "@/app/api/v1/invoices/[id]/send/route";
import { POST as resend } from "@/app/api/v1/invoices/[id]/resend/route";

describe("approve without sending, and send later, over the API", () => {
  const get = useApiDb();
  let admin: Actor;
  let f: Awaited<ReturnType<typeof setupFixture>>;

  beforeAll(async () => {
    const { db } = get();
    f = await setupFixture(db, "snd-api");
    admin = (await makeUser(db, "admin", "snd-api-admin@example.test")).actor;
    await db.update(vendors).set({ billingEmails: ["ap@vendor.example"] }).where(eq(vendors.id, f.vendorId));
    await db.transaction((tx) =>
      updateSettings(admin, tx, { email: { provider: "smtp", from: "Sheriff <no-reply@sheriff.example>", smtp: { host: "smtp.test" } }, billingReplyToEmail: "billing@sheriff.example", invoiceReviewMode: "all" }),
    );
  });

  const key = async (scopes: Array<"read" | "write">) => (await get().db.transaction((tx) => createApiKey(admin, tx, { name: `Send ${scopes.join("+")}`, scopes }))).key;
  const post = (handler: typeof approve, path: string, token: string, id: string, body?: unknown) =>
    call(handler, path, { method: "POST", headers: { ...bearer(token), "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body), params: { id } });
  const held = async () => {
    const { db } = get();
    const p = await f.person();
    await db.update(users).set({ mailingAddress: "1 Main St, Town, TX 75001" }).where(eq(users.id, p.userId));
    const { job, positionId } = await f.mkJob();
    const [a] = await db.insert(assignments).values({ jobId: job.id, jobPositionId: positionId, userId: p.userId, status: "signed_up" }).returning();
    return (await db.transaction((tx) => billAssignment(p, tx, a.id, { startAt: job.startAt, endAt: job.endAt, attachW9: false }, agencyInstant(2035, 12, 31, 9, 0)))).invoice;
  };
  const status = async (id: string) => (await get().db.select().from(invoices).where(eq(invoices.id, id)))[0].status;

  test("send: false approves without sending; POST /send then sends it; a read key cannot send", async () => {
    const inv = await held();
    const write = await key(["write"]);
    const res = await post(approve, `/api/v1/invoices/${inv.id}/approve`, write, inv.id, { send: false });
    expect(res.status, await res.clone().text()).toBe(200);
    expect((await res.json()).data.status).toBe("approved_unsent");
    expect((await post(send, `/api/v1/invoices/${inv.id}/send`, await key(["read"]), inv.id)).status).toBe(403);
    expect(await status(inv.id)).toBe("approved_unsent");
    const sent = await post(send, `/api/v1/invoices/${inv.id}/send`, write, inv.id);
    expect(sent.status, await sent.clone().text()).toBe(200);
    expect(await status(inv.id)).toBe("sent");
  });

  test("with no body, the vendor's setting decides", async () => {
    const { db } = get();
    await db.update(vendors).set({ emailApprovedInvoices: false }).where(eq(vendors.id, f.vendorId));
    const inv = await held();
    const res = await post(approve, `/api/v1/invoices/${inv.id}/approve`, await key(["write"]), inv.id);
    expect(res.status, await res.clone().text()).toBe(200);
    expect(await status(inv.id)).toBe("approved_unsent");
  });

  test("POST /send sends a paid invoice's paid version, and is refused for a written-off one", async () => {
    const { db } = get();
    await db.update(vendors).set({ emailApprovedInvoices: true }).where(eq(vendors.id, f.vendorId));
    const write = await key(["write"]);
    const paid = await held();
    await db.update(invoices).set({ status: "paid", deputyPaidAt: new Date("2035-12-31T15:00:00Z"), responsibleParty: null }).where(eq(invoices.id, paid.id));
    const ok = await post(send, `/api/v1/invoices/${paid.id}/send`, write, paid.id);
    expect(ok.status, await ok.clone().text()).toBe(200);
    expect((await ok.json()).data).toMatchObject({ status: "paid" });
    const off = await held();
    await db.update(invoices).set({ status: "written_off", responsibleParty: null }).where(eq(invoices.id, off.id));
    expect((await post(send, `/api/v1/invoices/${off.id}/send`, write, off.id)).status).toBe(409);
    expect(await status(off.id)).toBe("written_off");
  });

  test("POST /resend sends again to the billing emails plus alsoTo; a read key gets 403; a never-sent invoice gets 409", async () => {
    const write = await key(["write"]);
    const inv = await held();
    expect((await post(resend, `/api/v1/invoices/${inv.id}/resend`, write, inv.id, {})).status).toBe(409);
    await post(approve, `/api/v1/invoices/${inv.id}/approve`, write, inv.id, { send: true });
    expect((await post(resend, `/api/v1/invoices/${inv.id}/resend`, await key(["read"]), inv.id, {})).status).toBe(403);
    const res = await post(resend, `/api/v1/invoices/${inv.id}/resend`, write, inv.id, { alsoTo: "owner@vendor.example" });
    expect(res.status, await res.clone().text()).toBe(200);
    expect((await res.json()).data.to).toEqual(["ap@vendor.example", "owner@vendor.example"]);
  });
});
