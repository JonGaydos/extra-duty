import { installEmailSender } from "@/bootstrap/email";
import { trainingConfigured } from "@/db/client";
import { getBoss, stopBoss } from "./boss";
import { registerEmailHandlers } from "./email-worker";
import { registerNotificationHandlers } from "./notification-worker";
import { registerSchedule } from "./schedule";

async function main(): Promise<void> {
  installEmailSender();
  const boss = await getBoss({ worker: true, mode: "live" });
  await registerEmailHandlers(boss, "live");
  await registerNotificationHandlers(boss, "live");
  // The cron lives on the live database; each tick runs against both databases (see runTick).
  await registerSchedule(boss);
  if (trainingConfigured()) {
    // Training's queue lives in the training database; its jobs run in training mode, so their email goes to the outbox.
    const training = await getBoss({ worker: true, mode: "training" });
    await registerEmailHandlers(training, "training");
    await registerNotificationHandlers(training, "training");
  }
  console.log(`Extra Duty worker started${trainingConfigured() ? " (live and training)" : ""}.`);

  const shutdown = () => {
    stopBoss().then(
      () => process.exit(0),
      (err) => {
        console.error("Worker shutdown failed:", err);
        process.exit(1);
      },
    );
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
}

main().catch((err) => {
  console.error("Worker failed to start:", err);
  process.exit(1);
});
