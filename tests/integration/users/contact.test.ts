import { describe, expect, test } from "vitest";
import { eq } from "drizzle-orm";
import { useTestDb } from "../../setup/test-db";
import { auditLog, users } from "@/db/schema";
import { ForbiddenError, ValidationError } from "@/domain/errors";
import { getOwnContact, updateOwnContact } from "@/domain/users/contact";
import { makeUser } from "./helpers";

describe("own contact details", () => {
  const get = useTestDb();

  test("a deputy updates their own phone and mailing address, audited", async () => {
    const { actor } = await makeUser(get().db, "personnel", "contact1@example.test");
    await get().db.transaction((tx) => updateOwnContact(actor, tx, { phone: " 850-555-0101 ", mailingAddress: "PO Box 9, Pine Harbor, FL 32401" }));
    const [row] = await get().db.select().from(users).where(eq(users.id, actor.userId));
    expect(row.phone).toBe("850-555-0101");
    expect(row.mailingAddress).toBe("PO Box 9, Pine Harbor, FL 32401");
    const contact = await get().db.transaction((tx) => getOwnContact(actor, tx));
    expect(contact).toMatchObject({ email: "contact1@example.test", phone: "850-555-0101", mailingAddress: "PO Box 9, Pine Harbor, FL 32401" });
    const audits = await get().db.select().from(auditLog).where(eq(auditLog.action, "user.contact_update"));
    expect(audits).toHaveLength(1);
    expect(audits[0].entityId).toBe(actor.userId);
  });

  test("blank values clear, long values are refused, vendors are refused", async () => {
    const { actor } = await makeUser(get().db, "personnel", "contact2@example.test");
    await get().db.transaction((tx) => updateOwnContact(actor, tx, { phone: "  ", mailingAddress: "" }));
    const [row] = await get().db.select().from(users).where(eq(users.id, actor.userId));
    expect(row.phone).toBeNull();
    expect(row.mailingAddress).toBeNull();
    await expect(get().db.transaction((tx) => updateOwnContact(actor, tx, { phone: "1".repeat(41), mailingAddress: null }))).rejects.toBeInstanceOf(ValidationError);
    const vendor = (await makeUser(get().db, "vendor", "contact3@example.test")).actor;
    await expect(get().db.transaction((tx) => updateOwnContact(vendor, tx, { phone: null, mailingAddress: null }))).rejects.toBeInstanceOf(ForbiddenError);
  });
});
