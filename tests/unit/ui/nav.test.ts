import { describe, expect, test } from "vitest";
import type { Role } from "@/domain/actor";
import { currentTab, navFor } from "@/ui/shell/nav";

describe("current phone tab", () => {
  const coord = navFor("coordinator");
  const vendor = navFor("vendor");
  const deputy = navFor("personnel");

  test("a section in the bar is current, even under a parent path", () => {
    expect(currentTab(coord, "/home")).toBe("/home");
    expect(currentTab(coord, "/jobs")).toBe("/jobs");
    expect(currentTab(coord, "/jobs/123")).toBe("/jobs");
    expect(currentTab(coord, "/jobs/new")).toBe("/jobs");
    expect(currentTab(coord, "/billing/bill/5")).toBe("/billing");
    expect(currentTab(vendor, "/vendor/request")).toBe("/vendor/request");
  });

  test("a section that lives under More marks More, never its parent tab", () => {
    expect(currentTab(coord, "/coordinate")).toBe("/more");
    expect(currentTab(coord, "/coordinate/payments")).toBe("/more");
    expect(currentTab(coord, "/coordinate/vendors/9")).toBe("/more");
    expect(currentTab(coord, "/admin")).toBe("/more");
    expect(currentTab(coord, "/profile")).toBe("/more");
    expect(currentTab(coord, "/map")).toBe("/more");
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
});

const hrefs = (items: { href: string }[]) => items.map((i) => i.href);
const labels = (items: { label: string }[]) => items.map((i) => i.label);

describe("deputy sections", () => {
  const deputy = navFor("personnel");

  test("desktop: Home, Details, Calendar, Billing, Messages and Profile; Map is not its own tab", () => {
    expect(labels(deputy.desktop)).toEqual(["Home", "Details", "Calendar", "Billing", "Messages", "Profile"]);
    expect(hrefs(deputy.desktop)).toEqual(["/home", "/jobs", "/calendar", "/billing", "/messages", "/profile"]);
  });

  test("phone: Home, Details, Calendar, Billing and More; More lists Map, Messages, Profile and Help", () => {
    expect(labels(deputy.phone)).toEqual(["Home", "Details", "Calendar", "Billing", "More"]);
    expect(labels(deputy.more)).toEqual(["Map", "Messages", "Profile", "Help"]);
    expect(deputy.staff).toEqual([]);
  });
});

describe("the same screens for everyone but vendors", () => {
  const deputy = navFor("personnel");
  const roles: Role[] = ["personnel", "coordinator", "admin"];

  for (const role of roles) {
    for (const outbox of [false, true]) {
      const nav = navFor(role, { outbox });
      const name = `${role}${outbox ? " with the outbox" : ""}`;

      test(`${name}: the shared tabs are the deputy's, in the same order, on desktop, phone and More`, () => {
        expect(nav.desktop).toEqual(deputy.desktop);
        expect(nav.phone).toEqual(deputy.phone);
        expect(nav.more).toEqual(deputy.more);
      });

      test(`${name}: starts on Home`, () => {
        expect(nav.home).toBe("/home");
      });
    }
  }
});

describe("coordinators and admins have everything a deputy has", () => {
  const deputy = navFor("personnel");

  for (const role of ["coordinator", "admin"] as const) {
    for (const outbox of [false, true]) {
      const nav = navFor(role, { outbox });

      test(`${role}${outbox ? " with the outbox" : ""}: every deputy desktop section is on the desktop bar`, () => {
        const desktop = hrefs([...nav.desktop, ...nav.staff]);
        for (const href of hrefs(deputy.desktop)) expect(desktop, href).toContain(href);
      });

      test(`${role}${outbox ? " with the outbox" : ""}: every deputy phone section is in the tab bar or on More`, () => {
        const phone = hrefs([...nav.phone, ...nav.more, ...nav.staff]);
        for (const href of hrefs([...deputy.phone, ...deputy.more])) expect(phone, href).toContain(href);
      });
    }
  }

  test("staff tabs follow the shared ones: To-do, Payments, Vendors, Reports and Management", () => {
    expect(labels(navFor("coordinator").staff)).toEqual(["To-do", "Payments", "Vendors", "Reports", "Management"]);
    expect(hrefs(navFor("admin").staff)).toEqual(["/coordinate", "/coordinate/payments", "/coordinate/vendors", "/coordinate/reports", "/admin"]);
    expect(labels(navFor("admin", { outbox: true }).staff)).toEqual(["To-do", "Payments", "Vendors", "Reports", "Management", "Outbox"]);
  });

  test("no sixth phone tab for staff", () => {
    expect(navFor("admin", { outbox: true }).phone).toHaveLength(5);
  });

  test("vendors keep their own sections and no staff tabs", () => {
    const vendor = navFor("vendor");
    expect(labels(vendor.desktop)).toEqual(["My details", "Request a detail", "Invoices", "Locations", "Contracts"]);
    expect(labels(vendor.phone)).toEqual(["My details", "Request a detail", "Invoices", "Locations", "More"]);
    expect(labels(vendor.more)).toEqual(["Contracts", "Profile", "Help"]);
    expect(vendor.staff).toEqual([]);
    expect(vendor.home).toBe("/vendor");
  });
});

describe("vendor managers (owner decision 2026-11-27)", () => {
  const manager = navFor("personnel", { manager: true });

  test("keep the deputy tabs and add Manage after them", () => {
    expect(manager.desktop).toEqual(navFor("personnel").desktop);
    expect(manager.phone).toEqual(navFor("personnel").phone);
    expect(labels(manager.staff)).toEqual(["Manage"]);
    expect(hrefs(manager.staff)).toEqual(["/manage"]);
    expect(currentTab(manager, "/manage/vendors/3")).toBe("/more");
  });

  test("coordinators and admins never get Manage; they have every staff tab", () => {
    expect(labels(navFor("coordinator", { manager: true }).staff)).not.toContain("Manage");
    expect(navFor("vendor", { manager: true }).staff).toEqual([]);
  });
});
