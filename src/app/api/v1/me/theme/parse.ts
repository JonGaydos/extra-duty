import type { ThemePreference } from "@/domain/users/profile";

/** Body `{ theme: "day" | "night" | "system" }`; anything else is null (a 400). "system" clears the override. */
export function parseThemeBody(body: unknown): { theme: ThemePreference } | null {
  const theme = (body as { theme?: unknown } | null)?.theme;
  if (theme === "day" || theme === "night") return { theme };
  if (theme === "system") return { theme: null };
  return null;
}
