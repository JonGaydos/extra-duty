import { setThemePreference } from "@/domain/users/profile";
import { apiHandler } from "@/lib/api/handler";
import { routes } from "@/lib/api/registry";
import { parseThemeBody } from "./parse";

/** Body `{ theme }`: "day", "night", or "system" to follow the device. */
export const PUT = apiHandler(routes["PUT /me/theme"], async ({ actor, body, run }) => {
  const { theme } = parseThemeBody(body)!;
  await run((tx) => setThemePreference(actor, tx, theme));
  return { theme: theme ?? "system" };
});
