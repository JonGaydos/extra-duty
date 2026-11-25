import type { ThemePreference } from "@/domain/users/profile";

/** The cookie holding the theme override. Absent means "follow the device". */
export const THEME_COOKIE = "ed-theme";
const ONE_YEAR_S = 365 * 24 * 3600;

export function parseTheme(value: string | undefined | null): ThemePreference {
  return value === "day" || value === "night" ? value : null;
}

/** The document.cookie assignment that stores (or clears) the override. */
export function themeCookie(theme: ThemePreference): string {
  return theme
    ? `${THEME_COOKIE}=${theme}; Path=/; Max-Age=${ONE_YEAR_S}; SameSite=Lax`
    : `${THEME_COOKIE}=; Path=/; Max-Age=0; SameSite=Lax`;
}

/**
 * Browser chrome color (meta theme-color) for each theme. Meta tags cannot
 * read CSS variables, so these repeat the canvas token from tokens.css.
 */
export const THEME_COLOR = { day: "#f4f6f8", night: "#0f1318" } as const;

/** The color a theme-color meta should carry: the override, or what its media query matches. */
export function themeColorFor(theme: ThemePreference, media: string | null): string {
  return THEME_COLOR[theme ?? (media?.includes("dark") ? "night" : "day")];
}
