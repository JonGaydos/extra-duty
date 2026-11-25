import { setEarningsGoal } from "@/domain/planning/preferences";
import { goalProgress } from "@/domain/planning/recommend";
import { apiHandler } from "@/lib/api/handler";
import { routes } from "@/lib/api/registry";

/** The goal and this month's progress. */
export const GET = apiHandler(routes["GET /me/earnings-goal"], async ({ actor, run }) => run((tx) => goalProgress(actor, tx, new Date())));

/** Body `{ monthlyCents }`; null clears the goal. */
export const PUT = apiHandler(routes["PUT /me/earnings-goal"], async ({ actor, body, run }) =>
  run(async (tx) => {
    await setEarningsGoal(actor, tx, body.monthlyCents);
    return goalProgress(actor, tx, new Date());
  }),
);
