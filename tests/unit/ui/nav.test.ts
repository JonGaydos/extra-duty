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

  test("deputies have every section in the bar", () => {
    expect(currentTab(deputy, "/profile")).toBe("/profile");
    expect(currentTab(deputy, "/jobs/42")).toBe("/jobs");
    expect(currentTab(deputy, "/somewhere-else")).toBeUndefined();
  });
});
