import { describe, expect, it } from "vitest";
import { ackBannerText } from "@/domain/messages/ack-text";

const row = (n: number) => ({ messageId: `m${n}`, subject: `Policy ${n}`, senderName: "Pat Lee", sentAt: new Date(2035, 0, n), dueAt: null });

describe("the acknowledgement banner", () => {
  it("is absent with nothing to acknowledge", () => {
    expect(ackBannerText([])).toBeNull();
  });

  it("names the sender and subject of a single message and opens it", () => {
    expect(ackBannerText([row(1)])).toEqual({ title: "Important message from Pat Lee: Policy 1. Read and acknowledge.", detail: null, href: "/messages/m1" });
  });

  it("shows a count for several and opens the oldest first", () => {
    const t = ackBannerText([row(1), row(2), row(3)]);
    expect(t?.title).toBe("3 important messages to read and acknowledge.");
    expect(t?.href).toBe("/messages/m1");
    expect(t?.detail).toBe("Oldest first: Policy 1, from Pat Lee.");
  });
});
