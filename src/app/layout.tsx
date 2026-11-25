import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";
import { cookies } from "next/headers";
import { ServiceWorker } from "@/ui/shell/ServiceWorker";
import { THEME_COOKIE, parseTheme, themeColorFor } from "@/ui/theme";
import "./globals.css";

// Inter from a committed file, so the build works offline; served from this app, never from Google. The file is
// Inter 4.1 (github.com/rsms/inter, web/InterVariable.woff2) with optical size fixed at 14 and subset to Latin and
// Latin Extended, weights 100 to 900 (fonttools varLib.instancer, then pyftsubset). SIL OFL 1.1: fonts/Inter-LICENSE.txt.
const inter = localFont({ src: "./fonts/InterVariable-latin.woff2", weight: "100 900", style: "normal", variable: "--font-inter", display: "swap", fallback: ["Arial"] });

export const metadata: Metadata = {
  title: { default: "Extra Duty", template: "%s | Extra Duty" },
  description: "Off-duty detail scheduling",
  applicationName: "Extra Duty",
  manifest: "/manifest.webmanifest",
  appleWebApp: { capable: true, title: "Extra Duty", statusBarStyle: "default" },
  icons: {
    icon: [{ url: "/icons/icon-192.png", sizes: "192x192", type: "image/png" }],
    apple: "/icons/apple-touch-icon.png",
  },
};

const LIGHT = "(prefers-color-scheme: light)";
const DARK = "(prefers-color-scheme: dark)";

/** Browser chrome color: the canvas of the theme override, else of each device scheme. */
export async function generateViewport(): Promise<Viewport> {
  const theme = parseTheme((await cookies()).get(THEME_COOKIE)?.value);
  return {
    width: "device-width",
    initialScale: 1,
    viewportFit: "cover",
    themeColor: [
      { media: LIGHT, color: themeColorFor(theme, LIGHT) },
      { media: DARK, color: themeColorFor(theme, DARK) },
    ],
  };
}

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // The override is rendered by the server, so the first paint is already in the right theme.
  const theme = parseTheme((await cookies()).get(THEME_COOKIE)?.value);
  return (
    <html lang="en" className={inter.variable} data-theme={theme ?? undefined} suppressHydrationWarning>
      <body>
        {children}
        <ServiceWorker />
      </body>
    </html>
  );
}
