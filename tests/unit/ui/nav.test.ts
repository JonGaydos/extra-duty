import { describe, expect, test } from "vitest";
import { currentTab, navFor } from "@/ui/shell/nav";

describe("current phone tab", () => {
  const coord = navFor("coordinator");
  const vendor = navFor("vendor");
  const deputy = navFor("personnel");

  test("a section in the bar is current, even under a parent path", () => {
    expect(currentTab(coord, "/coordinate")).toBe("/coordinate");
    expect(currentTab(coord, "/coordinate/details")).toBe("/coordinate/details");
    expect(currentTab(coord, "/coordinate/details/123")).toBe("/coordinate/details");
    expect(currentTab(vendor, "/vendor/request")).toBe("/vendor/request");
  });

  test("a section that lives under More marks More, never its parent tab", () => {
    expect(currentTab(coord, "/coordinate/payments")).toBe("/more");
    expect(currentTab(coord, "/coordinate/vendors/9")).toBe("/more");
    expect(currentTab(coord, "/admin")).toBe("/more");
    expect(currentTab(coord, "/profile")).toBe("/more");
    expect(currentTab(coord, "/more")).toBe("/more");
    expect(currentTab(vendor, "/vendor/contracts")).toBe("/more");
  });

  test("a deputy's Map, Messages and Profile live under More on the phone", () => {
    expect(currentTab(deputy, "/jobs/42")).toBe("/jobs");
    expect(currentTab(deputy, "/calendar")).toBe("/calendar");
    expect(currentTab(deputy, "/map")).toBe("/more");
    expect(currentTab(deputy, "/messages/7")).toBe("/more");
    expect(currentTab(deputy, "/profile")).toBe("/more");
    expect(currentTab(deputy, "/somewhere-else")).toBeUndefined();
  });

  test("a coordinator's own work marks More on the phone", () => {
    expect(currentTab(coord, "/home")).toBe("/more");
    expect(currentTab(coord, "/billing/bill/5")).toBe("/more");
    expect(currentTab(coord, "/map")).toBe("/more");
  });
});

const hrefs = (items: { href: string }[]) => items.map((i) => i.href);

describe("deputy sections", () => {
  const deputy = navFor("personnel");

  test("desktop: Home, Details, Calendar, Billing, Messages and Profile; Map is not its own tab", () => {
    expect(deputy.desktop.map((i) => i.label)).toEqual(["Home", "Details", "Calendar", "Billing", "Messages", "Profile"]);
    expect(hrefs(deputy.desktop)).toEqual(["/home", "/jobs", "/calendar", "/billing", "/messages", "/profile"]);
  });

  test("phone: Home, Details, Calendar, Billing and More; More lists Map, Messages, Profile and Help", () => {
    expect(deputy.phone.map((i) => i.label)).toEqual(["Home", "Details", "Calendar", "Billing", "More"]);
    expect(deputy.more.map((i) => i.label)).toEqual(["Map", "Messages", "Profile", "Help"]);
  });
});

describe("coordinators and admins have everything a deputy has", () => {
  const deputy = navFor("personnel");

  for (const role of ["coordinator", "admin"] as const) {
    for (const outbox of [false, true]) {
      const nav = navFor(role, { outbox });

      test(`${role}${outbox ? " with the outbox" : ""}: every deputy desktop section is on the desktop bar`, () => {
        const desktop = hrefs([...nav.desktop, ...nav.personal]);
        for (const href of hrefs(deputy.desktop)) expect(desktop, href).toContain(href);
      });

      test(`${role}${outbox ? " with the outbox" : ""}: every deputy phone section is in the tab bar or on More`, () => {
        const phone = hrefs([...nav.phone, ...nav.more]);
        for (const href of hrefs([...deputy.phone, ...deputy.more])) expect(phone, href).toContain(href);
      });
    }
  }

  test("the personal items are grouped apart on the desktop bar, and the four phone tabs stay", () => {
    const coord = navFor("coordinator");
    expect(coord.personal.map((i) => i.label)).toEqual(["My work", "Open details", "My billing", "Profile"]);
    expect(hrefs(coord.personal)).toEqual(["/home", "/jobs", "/billing", "/profile"]);
    expect(coord.desktop.map((i) => i.label)).toEqual(["To-do", "Details", "Calendar", "Vendors", "Payments", "Reports", "Messages", "Management"]);
    expect(coord.phone.map((i) => i.label)).toEqual(["To-do", "Details", "Calendar", "Messages", "More"]);
    expect(coord.more.map((i) => i.label)).toEqual(["Vendors", "Payments", "Reports", "Management", "My work", "Open details", "My billing", "Map", "Profile", "Help"]);
  });

  test("deputies and vendors have no separate personal group", () => {
    expect(navFor("personnel").personal).toEqual([]);
    expect(navFor("vendor").personal).toEqual([]);
  });
});
