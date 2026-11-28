"use server";

import { resetMessage, saveMessage, sendTestMessage } from "@/domain/email-messages/store";
import { withTx } from "@/ui/shell/request";
import { act, actOutsideTx, type ActionResult } from "../../_personnel/result";

/** Server actions for the Email messages editor (Management, Reminders and locks). */

export async function saveMessageAction(input: { key: string; subject: string; body: string }): Promise<ActionResult> {
  return act(async (actor, tx) => {
    await saveMessage(actor, tx, input.key, { subject: input.subject, body: input.body });
    return { ok: true, message: "Message saved. It is used from the next email on." };
  });
}

export async function resetMessageAction(input: { key: string }): Promise<ActionResult> {
  return act(async (actor, tx) => {
    await resetMessage(actor, tx, input.key);
    return { ok: true, message: "Message reset to the default." };
  });
}

export async function sendTestMessageAction(input: { key: string; subject: string; body: string }): Promise<ActionResult> {
  return actOutsideTx(async (actor) => {
    const to = await sendTestMessage(actor, withTx, input.key, { subject: input.subject, body: input.body });
    return { ok: true, message: `Test sent to ${to}.` };
  });
}
