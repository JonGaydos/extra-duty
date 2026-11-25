import { describe, expect, test } from "vitest";
import { reportAccess } from "@/app/api/v1/reports/parse";
import { errorResponse } from "@/lib/api/handler";
import { downloadError } from "@/app/(app)/coordinate/reports/download";
import { ForbiddenError, ValidationError } from "@/domain/errors";

describe("a failed report export says why", () => {
  test("the export route turns a domain error into a JSON message with its status", async () => {
    const tooBig = errorResponse(new ValidationError("This report covers more than 50,000 records. Narrow the date range or add filters."));
    expect(tooBig.status).toBe(400);
    expect(await tooBig.json()).toEqual({ error: { code: "validation", message: "This report covers more than 50,000 records. Narrow the date range or add filters." } });
    const refused = await reportAccess(Promise.reject(new ForbiddenError())).catch((e: unknown) => e);
    const forbidden = errorResponse(refused);
    expect(forbidden.status).toBe(403);
    expect((await forbidden.json()).error.message).toBe("Only coordinators and admins can run reports.");
    expect(() => errorResponse(new Error("boom"))).toThrow("boom");
  });

  test("the page reads the message, or says the download failed", async () => {
    expect(await downloadError(Response.json({ error: { code: "validation", message: "Choose a start date." } }, { status: 400 }))).toBe("Choose a start date.");
    expect(await downloadError(new Response("<html>oops</html>", { status: 500 }))).toBe("The download did not work. Try again.");
  });
});
