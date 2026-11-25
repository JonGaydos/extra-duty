"use server";

import { addVendorContact, setVendorContactActive, updateVendorContact } from "@/domain/vendors/contacts";
import { act, type ActionResult } from "../../_personnel/result";

/** Site contact actions for the coordinator vendor record and the vendor portal; the service scopes vendors to their own. */

export type ContactWire = { name: string; phone: string; email: string; notes: string };

export async function addContactAction(input: ContactWire & { vendorId: string }): Promise<ActionResult> {
  return act(async (actor, tx) => {
    await addVendorContact(actor, tx, input.vendorId, input);
    return { ok: true, message: "Contact added." };
  });
}

export async function updateContactAction(input: ContactWire & { contactId: string }): Promise<ActionResult> {
  return act(async (actor, tx) => {
    await updateVendorContact(actor, tx, input.contactId, input);
    return { ok: true, message: "Contact saved." };
  });
}

export async function contactActiveAction(input: { contactId: string; active: boolean }): Promise<ActionResult> {
  return act(async (actor, tx) => {
    await setVendorContactActive(actor, tx, input.contactId, input.active);
    return { ok: true, message: input.active ? "Contact reactivated." : "Contact deactivated. Details that name them keep their copy." };
  });
}
