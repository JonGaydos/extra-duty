import { runnerFor, withTx } from "@/db/client";
import { getSettings } from "@/domain/settings/settings";
import { resetTrainingData } from "@/domain/training/reset";

/**
 * Nightly at 2:00 AM agency time, in training mode only: puts the training data back to the starting demo data,
 * unless an admin turned it off (the live setting `trainingNightlyReset`, on by default).
 */
export async function trainingResetTick(now: Date): Promise<boolean> {
  const { trainingNightlyReset } = await runnerFor("live")(getSettings);
  if (!trainingNightlyReset) return false;
  await withTx((tx) => resetTrainingData("system", tx, now));
  return true;
}
