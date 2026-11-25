import { afterEach, describe, expect, test, vi } from "vitest";
import { createMemorySender } from "@/lib/email/types";

describe("email sender holder", () => {
  afterEach(() => {
    delete (globalThis as Record<symbol, unknown>)[Symbol.for("extra-duty.email-sender")];
  });

  test("two separate module instances share one sender", async () => {
    vi.resetModules();
    const a = await import("@/lib/email/sender");
    vi.resetModules();
    const b = await import("@/lib/email/sender");
    expect(a).not.toBe(b);
    expect(b.hasEmailSender()).toBe(false);
    await expect(b.getEmailSender().send({ to: [], subject: "", text: "", html: "" })).rejects.toThrow("not configured");
    const mail = createMemorySender();
    a.setEmailSender(mail);
    expect(b.hasEmailSender()).toBe(true);
    expect(b.getEmailSender()).toBe(mail);
  });
});
