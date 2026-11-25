"use server";

import { resetTrainingData } from "@/domain/training/reset";
import { act, type ActionResult } from "../../_personnel/result";

/** Puts the training data back to the starting demo data. Training mode only (the service refuses anywhere else). */
export async function resetTrainingAction(): Promise<ActionResult> {
  return act(async (actor, tx) => {
    await resetTrainingData(actor, tx);
    return { ok: true, message: "Training data is back to the starting demo data." };
  });
}
