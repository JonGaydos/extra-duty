import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { useApiDb, bearer, call, sessionToken } from "./helpers";
import { setupFixture } from "../assignments/helpers";
import { makeUser } from "../users/helpers";
import { auditLog, jobAttachments, vendorUsers } from "@/db/schema";
import type { Actor } from "@/domain/actor";
import { ForbiddenError, ValidationError } from "@/domain/errors";
import { uploadFile } from "@/domain/files/files";
import { attachContractToJob } from "@/domain/jobs/attachments";
import { addVendorDocument } from "@/domain/vendors/vendors";
import { resetGeocoder } from "@/domain/vendors/geocode";
import { GET as vendorDocFile } from "@/app/api/v1/vendors/[id]/documents/[documentId]/file/route";
import { POST as addDocument } from "@/app/api/v1/vendors/[id]/documents/route";
import { GET as attachmentFile } from "@/app/api/v1/jobs/[id]/attachments/[attachmentId]/file/route";
import { POST as attachRoute } from "@/app/api/v1/jobs/[id]/attachments/route";
import { POST as vendorRequest } from "@/app/api/v1/vendor-requests/route";

const PDF = Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.from("contract body ".repeat(10))]);

describe("vendor documents and detail contracts", () => {
  const get = useApiDb();
  let fx: Awaited<ReturnType<typeof setupFixture>>;
  const tokens: Record<"coord" | "vendor" | "otherVendor" | "deputy", string> = { coord: "", vendor: "", otherVendor: "", deputy: "" };
  let deputy: Actor;
  let docId: string;
  let jobId: string;

  beforeAll(async () => {
    const { db } = get();
    fx = await setupFixture(db, "files");
    const coordRow = (await makeUser(db, "coordinator", "files-c2@example.test")).row;
    tokens.coord = await sessionToken(db, coordRow.id);
    for (const [k, vendorId] of [["vendor", fx.vendorId], ["otherVendor", fx.otherVendorId]] as const) {
      const v = await makeUser(db, "vendor", `files-${k}@example.test`);
      await db.insert(vendorUsers).values({ userId: v.row.id, vendorId });
      tokens[k] = await sessionToken(db, v.row.id);
    }
    deputy = await fx.person();
    tokens.deputy = await sessionToken(db, deputy.userId);
    const doc = await fx.run((tx) => addVendorDocument(fx.coord, tx, fx.vendorId, { kind: "contract", label: "Master agreement", file: PDF, filename: "agreement.pdf", contentType: "application/pdf" }));
    docId = doc.id;
    jobId = (await fx.mkJob()).job.id;
  });
  afterEach(() => vi.unstubAllGlobals());

  test("a vendor document downloads for that vendor and staff; another vendor and personnel get 404", async () => {
    const path = `/api/v1/vendors/${fx.vendorId}/documents/${docId}/file`;
    const params = { id: fx.vendorId, documentId: docId };
    for (const who of ["vendor", "coord"] as const) {
      const res = await call(vendorDocFile, path, { headers: bearer(tokens[who]), params });
      expect(res.status, who).toBe(200);
      expect(res.headers.get("content-disposition")).toContain("attachment");
      expect(Buffer.from(await res.arrayBuffer()).equals(PDF)).toBe(true);
    }
    for (const who of ["otherVendor", "deputy"] as const) {
      expect((await call(vendorDocFile, path, { headers: bearer(tokens[who]), params })).status, who).toBe(404);
    }
    // Under another vendor's id, the document is not found.
    expect((await call(vendorDocFile, `/api/v1/vendors/${fx.otherVendorId}/documents/${docId}/file`, { headers: bearer(tokens.coord), params: { id: fx.otherVendorId, documentId: docId } })).status).toBe(404);
  });

  test("a document upload reads its dates as agency days and keeps to the upload limit", async () => {
    const form = new FormData();
    form.set("kind", "other");
    form.set("label", "Insurance");
    form.set("signedOn", "2026-03-08");
    form.set("expiresOn", "2026-11-01");
    form.set("file", new File([PDF], "ins.pdf", { type: "application/pdf" }));
    const body = new Response(form);
    const buf = new Uint8Array(await body.arrayBuffer());
    const res = await call(addDocument, `/api/v1/vendors/${fx.vendorId}/documents`, {
      method: "POST",
      headers: { ...bearer(tokens.coord), "content-type": body.headers.get("content-type")!, "content-length": String(buf.byteLength) },
      body: buf,
      params: { id: fx.vendorId },
    });
    expect(res.status).toBe(201);
    expect((await res.json()).data).toMatchObject({ signedOn: "2026-03-08", expiresOn: "2026-11-01" });
    const huge = await call(addDocument, `/api/v1/vendors/${fx.vendorId}/documents`, {
      method: "POST",
      headers: { ...bearer(tokens.coord), "content-type": "multipart/form-data; boundary=x", "content-length": String(30 * 1024 * 1024) },
      body: "x",
      params: { id: fx.vendorId },
    });
    expect(huge.status).toBe(413);
  });

  test("a coordinator attaches a contract to one detail, audited; personnel cannot", async () => {
    const { db } = get();
    const row = await fx.run((tx) => attachContractToJob(fx.coord, tx, jobId, { label: "Event contract", file: { body: PDF, filename: "event.pdf", contentType: "application/pdf" } }));
    expect(row).toMatchObject({ jobId, label: "Event contract", isContract: true });
    const audit = await db.select().from(auditLog).where(and(eq(auditLog.action, "job_attachment.create"), eq(auditLog.entityId, row.id)));
    expect(audit).toHaveLength(1);
    await expect(fx.run((tx) => attachContractToJob(deputy, tx, jobId, { label: "X", url: "https://example.test/c" }))).rejects.toBeInstanceOf(ForbiddenError);
    await expect(fx.run((tx) => attachContractToJob(fx.coord, tx, jobId, { label: " ", url: "https://example.test/c" }))).rejects.toBeInstanceOf(ValidationError);
    await expect(fx.run((tx) => attachContractToJob(fx.coord, tx, jobId, { label: "Both", url: "https://example.test/c", file: { body: PDF, filename: "a.pdf", contentType: "application/pdf" } }))).rejects.toBeInstanceOf(ValidationError);
  });

  test("the attach route takes a link or a file; the contract downloads for staff and the vendor, never personnel", async () => {
    const form = new FormData();
    form.set("label", "Linked contract");
    form.set("url", "https://example.test/contract");
    const body = new Response(form);
    const buf = new Uint8Array(await body.arrayBuffer());
    const res = await call(attachRoute, `/api/v1/jobs/${jobId}/attachments`, {
      method: "POST",
      headers: { ...bearer(tokens.coord), "content-type": body.headers.get("content-type")!, "content-length": String(buf.byteLength) },
      body: buf,
      params: { id: jobId },
    });
    expect(res.status).toBe(201);
    expect((await res.json()).data).toMatchObject({ isContract: true, url: "https://example.test/contract" });

    const { db } = get();
    const [contract] = await db.select().from(jobAttachments).where(and(eq(jobAttachments.jobId, jobId), eq(jobAttachments.label, "Event contract")));
    const path = `/api/v1/jobs/${jobId}/attachments/${contract.id}/file`;
    const params = { id: jobId, attachmentId: contract.id };
    for (const who of ["coord", "vendor"] as const) expect((await call(attachmentFile, path, { headers: bearer(tokens[who]), params })).status, who).toBe(200);
    for (const who of ["deputy", "otherVendor"] as const) expect((await call(attachmentFile, path, { headers: bearer(tokens[who]), params })).status, who).toBe(404);

    // A plain attachment (not a contract) is open to personnel.
    const f = await fx.run((tx) => uploadFile(fx.coord, tx, { kind: "attachment", filename: "map.pdf", contentType: "application/pdf", body: PDF }));
    const [plain] = await db.insert(jobAttachments).values({ jobId, label: "Site map", fileId: f.id }).returning();
    expect((await call(attachmentFile, `/api/v1/jobs/${jobId}/attachments/${plain.id}/file`, { headers: bearer(tokens.deputy), params: { id: jobId, attachmentId: plain.id } })).status).toBe(200);
  });

  test("a vendor request from someone who cannot send one is refused before any address lookup", async () => {
    resetGeocoder({ intervalMs: 0 });
    const fetchMock = vi.fn(async () => new Response("[]"));
    vi.stubGlobal("fetch", fetchMock);
    const form = new FormData();
    form.set("request", JSON.stringify({ safetyNotes: "Dogs", safetyAddresses: [{ address: "1 Lookup Rd", description: "Dog" }] }));
    const body = new Response(form);
    const buf = new Uint8Array(await body.arrayBuffer());
    const res = await call(vendorRequest, "/api/v1/vendor-requests", {
      method: "POST",
      headers: { ...bearer(tokens.deputy), "content-type": body.headers.get("content-type")!, "content-length": String(buf.byteLength) },
      body: buf,
    });
    expect(res.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
