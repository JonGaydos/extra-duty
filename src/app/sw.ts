/**
 * The service worker, served at /sw.js by ./sw.js/route.ts. It does two
 * things only: shows push notifications (payload `{ title, body, url }` from
 * src/lib/push/push.ts) and answers a failed page load with an offline page.
 * It never caches anything, so no signed-in data is stored on the device.
 *
 * `serviceWorker` is sent to the browser as source text, so it must not use
 * anything from module scope; everything it needs comes in as arguments.
 */

type Waitable = { waitUntil(p: Promise<unknown>): void };
type PushEventLike = Waitable & { data: { json(): unknown; text(): string } | null };
type NotificationEventLike = Waitable & { notification: { close(): void; data?: { url?: string } } };
type FetchEventLike = { request: { mode: string }; respondWith(r: Promise<Response>): void };
type WindowClientLike = { url: string; focus(): Promise<unknown> };

type ServiceWorkerScope = {
  location: { origin: string };
  addEventListener(type: "install" | "activate", fn: (e: Waitable) => void): void;
  addEventListener(type: "push", fn: (e: PushEventLike) => void): void;
  addEventListener(type: "notificationclick", fn: (e: NotificationEventLike) => void): void;
  addEventListener(type: "fetch", fn: (e: FetchEventLike) => void): void;
  skipWaiting(): Promise<void>;
  registration: { showNotification(title: string, options: Record<string, unknown>): Promise<void> };
  clients: {
    claim(): Promise<void>;
    matchAll(o: { type: "window"; includeUncontrolled: boolean }): Promise<readonly WindowClientLike[]>;
    openWindow(url: string): Promise<unknown>;
  };
};

function serviceWorker(sw: ServiceWorkerScope, offlineHtml: string): void {
  sw.addEventListener("install", () => {
    void sw.skipWaiting();
  });
  sw.addEventListener("activate", (e) => e.waitUntil(sw.clients.claim()));

  sw.addEventListener("push", (e) => {
    let msg = { title: "Extra Duty", body: "", url: "/" };
    try {
      msg = { ...msg, ...(e.data?.json() as Partial<typeof msg>) };
    } catch {
      msg.body = e.data?.text() ?? "";
    }
    e.waitUntil(
      sw.registration.showNotification(msg.title, {
        body: msg.body,
        data: { url: msg.url },
        icon: "/icons/icon-192.png",
        badge: "/icons/badge-96.png",
      }),
    );
  });

  sw.addEventListener("notificationclick", (e) => {
    e.notification.close();
    const target = new URL(e.notification.data?.url ?? "/", sw.location.origin);
    // Only ever open pages on this site.
    const url = target.origin === sw.location.origin ? target.href : `${sw.location.origin}/`;
    e.waitUntil(
      sw.clients.matchAll({ type: "window", includeUncontrolled: true }).then((open) => {
        const same = open.find((c) => c.url === url);
        return same ? same.focus() : sw.clients.openWindow(url);
      }),
    );
  });

  sw.addEventListener("fetch", (e) => {
    if (e.request.mode !== "navigate") return;
    e.respondWith(
      fetch(e.request as Request).catch(
        () => new Response(offlineHtml, { status: 503, headers: { "content-type": "text/html; charset=utf-8" } }),
      ),
    );
  });
}

/*
 * Self-contained: the app's CSS and fonts are not reachable offline. The
 * values mirror src/ui/tokens.css (canvas, surface, line, ink, muted, accent)
 * for both themes, and the script applies a saved theme override.
 */
const OFFLINE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>Offline | Extra Duty</title>
<script>(function(){var m=document.cookie.match(/(?:^|; )ed-theme=(day|night)/);if(m)document.documentElement.setAttribute("data-theme",m[1])})()</script>
<style>
:root{color-scheme:light dark;--canvas:light-dark(#f4f6f8,#0f1318);--surface:light-dark(#fff,#171c23);--line:light-dark(#e3e6eb,#2a313b);--ink:light-dark(#14181f,#e8ecf1);--muted:light-dark(#5b6472,#9aa4b2);--accent:light-dark(#2147c2,#3d6bf0);--focus:light-dark(#2147c2,#8fb0ff)}
:root[data-theme=day]{color-scheme:light}:root[data-theme=night]{color-scheme:dark}
body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--canvas);color:var(--ink);font:14px/1.5 ui-sans-serif,system-ui,sans-serif;padding:20px;box-sizing:border-box}
main{max-width:360px;width:100%;background:var(--surface);border:1px solid var(--line);border-radius:18px;padding:24px;display:flex;flex-direction:column;gap:10px}
h1{margin:0;font-size:20px;line-height:1.25;font-weight:700}p{margin:0;color:var(--muted)}
a{margin-top:8px;display:inline-flex;align-items:center;justify-content:center;height:46px;border-radius:14px;background:var(--accent);color:#fff;font-weight:600;font-size:15px;text-decoration:none}
a:focus-visible{outline:2px solid var(--focus);outline-offset:2px}
</style>
</head>
<body>
<main>
<h1>You are offline</h1>
<p>Extra Duty needs a connection to load this page. Check your signal, then try again.</p>
<a href="">Try again</a>
</main>
</body>
</html>`;

/** The script served at /sw.js. */
export function serviceWorkerSource(): string {
  return `(${serviceWorker.toString()})(self, ${JSON.stringify(OFFLINE_HTML)});\n`;
}
