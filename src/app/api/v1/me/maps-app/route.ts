import { setMapsPreference } from "@/domain/users/profile";
import { apiHandler } from "@/lib/api/handler";
import { routes } from "@/lib/api/registry";

/** Body `{ app }`: "google", "apple", "osm", or "ask" to choose each time. */
export const PUT = apiHandler(routes["PUT /me/maps-app"], async ({ actor, body, run }) => {
  await run((tx) => setMapsPreference(actor, tx, body.app === "ask" ? null : body.app));
  return { app: body.app };
});
