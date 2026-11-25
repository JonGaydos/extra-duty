import { describe, expect, test, vi } from "vitest";
import { serviceWorkerSource } from "@/app/sw";

type Listener = (event: Record<string, unknown>) => void;

/** Runs the served script against a fake service worker global. */
function boot(fetchImpl: (req: never) => Promise<Response>) {
  const listeners = new Map<string, Listener>();
  const self = {
    location: { origin: "https://duty.example" },
    addEventListener: (type: string, fn: Listener) => listeners.set(type, fn),
    skipWaiting: vi.fn(async () => {}),
    registration: { showNotification: vi.fn(async () => {}) },
    clients: {
      claim: vi.fn(async () => {}),
      matchAll: vi.fn(async () => [] as Array<{ url: string; focus: () => Promise<void> }>),
      openWindow: vi.fn(async () => null),
    },
  };
  new Function("self", "fetch", "Response", "URL", serviceWorkerSource())(self, fetchImpl, Response, URL);
  const fire = async (type: string, event: Record<string, unknown>) => {
    const pending: Promise<unknown>[] = [];
    let responded: Promise<Response> | undefined;
    listeners.get(type)!({
      ...event,
      waitUntil: (p: Promise<unknown>) => pending.push(p),
      respondWith: (p: Promise<Response>) => (responded = p),
    });
    await Promise.all(pending);
    return responded;
  };
  return { self, fire, listeners };
}

describe("service worker", () => {
  test("a push shows the notification from its payload", async () => {
    const { self, fire } = boot(fetch);
    const payload = { title: "Detail opened", body: "Marsh Creek Town Center, today 2:00 PM", url: "/jobs/abc" };
    await fire("push", { data: { json: () => payload, text: () => JSON.stringify(payload) } });
    expect(self.registration.showNotification).toHaveBeenCalledWith(
      "Detail opened",
      expect.objectContaining({ body: payload.body, data: { url: "/jobs/abc" } }),
    );
  });

  test("tapping a notification opens its page on this site only", async () => {
    const { self, fire } = boot(fetch);
    const close = vi.fn();
    await fire("notificationclick", { notification: { close, data: { url: "/jobs/abc" } } });
    expect(close).toHaveBeenCalled();
    expect(self.clients.openWindow).toHaveBeenLastCalledWith("https://duty.example/jobs/abc");
    await fire("notificationclick", { notification: { close, data: { url: "https://evil.example/x" } } });
    expect(self.clients.openWindow).toHaveBeenLastCalledWith("https://duty.example/");
  });

  test("a failed page load shows the offline page; nothing else is intercepted or cached", async () => {
    const { fire, listeners } = boot(() => Promise.reject(new TypeError("offline")));
    const res = await fire("fetch", { request: { mode: "navigate", url: "https://duty.example/home" } });
    expect(res).toBeDefined();
    const page = await res!;
    expect(page.status).toBe(503);
    expect(await page.text()).toContain("You are offline");
    expect(await fire("fetch", { request: { mode: "cors", url: "https://duty.example/api/v1/jobs" } })).toBeUndefined();
    expect(serviceWorkerSource()).not.toMatch(/caches\./);
    expect([...listeners.keys()].sort()).toEqual(["activate", "fetch", "install", "notificationclick", "push"]);
  });
});
