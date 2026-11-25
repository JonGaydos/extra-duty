import { describe, expect, test } from "vitest";
import { TooLargeError, limitedFormData } from "@/app/api/v1/files";

/** A request whose body records whether anything read it. */
function request(body: Uint8Array, headers: Record<string, string>) {
  let pulled = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulled += 1;
      const chunk = body.subarray((pulled - 1) * 1024, pulled * 1024);
      if (chunk.byteLength === 0) controller.close();
      else controller.enqueue(chunk);
    },
  }, { highWaterMark: 0 });
  const req = new Request("http://test/upload", { method: "POST", body: stream, headers, duplex: "half" } as RequestInit);
  return { req, pulled: () => pulled };
}

const form = () => {
  const f = new FormData();
  f.set("request", "{}");
  f.set("contractFile", new File([new Uint8Array(100)], "c.pdf", { type: "application/pdf" }));
  return f;
};

async function encoded() {
  const res = new Response(form());
  return { body: new Uint8Array(await res.arrayBuffer()), type: res.headers.get("content-type")! };
}

describe("upload size limit", () => {
  test("a declared size over the limit is refused before any of the body is read", async () => {
    const { body, type } = await encoded();
    const r = request(body, { "content-type": type, "content-length": "999999999" });
    await expect(limitedFormData(r.req, 10_000)).rejects.toBeInstanceOf(TooLargeError);
    expect(r.pulled()).toBe(0);
  });

  test("a missing declared size is refused before any of the body is read", async () => {
    const { body, type } = await encoded();
    const r = request(body, { "content-type": type });
    await expect(limitedFormData(r.req, 10_000)).rejects.toBeInstanceOf(TooLargeError);
    expect(r.pulled()).toBe(0);
  });

  test("a body larger than it declared stops being read at the limit", async () => {
    const big = new Uint8Array(200_000);
    const r = request(big, { "content-type": "multipart/form-data; boundary=x", "content-length": "500" });
    await expect(limitedFormData(r.req, 4_096)).rejects.toBeInstanceOf(TooLargeError);
    expect(r.pulled()).toBeLessThanOrEqual(6);
  });

  test("a body within the limit is read as form data", async () => {
    const { body, type } = await encoded();
    const r = request(body, { "content-type": type, "content-length": String(body.byteLength) });
    const f = await limitedFormData(r.req, 10_000);
    expect(f?.get("request")).toBe("{}");
    expect((f?.get("contractFile") as File).size).toBe(100);
  });

  test("a too-large refusal answers 413", () => {
    expect(new TooLargeError("Too big").code).toBe("too_large");
  });
});
