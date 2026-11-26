import type { ThemePreference } from "@/domain/users/profile";
import { THEME_COLOR, themeCookie } from "./theme-cookie";

export type { ThemePreference };
export { THEME_COOKIE, parseTheme, themeColorFor } from "./theme-cookie";
export { ThemeToggle } from "./theme-toggle";

/**
 * Applies the profile's theme on a device whose cookie disagrees (a new
 * phone, or a change made elsewhere). The inline script runs while the page
 * parses, before the shell paints, and rewrites the cookie so the server
 * renders the right theme from then on. The browser chrome color follows.
 */
export function ThemeSync({ theme }: Readonly<{ theme: ThemePreference }>) {
  const set = theme ? `d.setAttribute("data-theme",${JSON.stringify(theme)})` : `d.removeAttribute("data-theme")`;
  const color = theme
    ? `function(){return ${JSON.stringify(THEME_COLOR[theme])}}`
    : `function(m){return (m.getAttribute("media")||"").indexOf("dark")>=0?${JSON.stringify(THEME_COLOR.night)}:${JSON.stringify(THEME_COLOR.day)}}`;
  const js =
    `(function(){var d=document.documentElement,c=${color};${set};` +
    `document.querySelectorAll('meta[name="theme-color"]').forEach(function(m){m.content=c(m)});` +
    `document.cookie=${JSON.stringify(themeCookie(theme))}})()`;
  return <script dangerouslySetInnerHTML={{ __html: js }} />;
}
