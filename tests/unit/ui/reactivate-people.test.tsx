import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test, vi } from "vitest";

vi.mock("@/app/(app)/coordinate/_coordinator/actions", () => ({}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));

const { ReactivatePeople } = await import("@/app/(app)/jobs/[id]/_manage/DetailActions");

const ann = { userId: "u1", name: "Ann Lee" };
const bo = { userId: "u2", name: "Bo Diaz" };
const text = (html: string, id: string) => new RegExp(`data-testid="${id}">([^<]*)<`).exec(html)?.[1] ?? null;

describe("reactivate confirm step lists", () => {
  test("names who is told and whose late-cancel pay is canceled, with no waive action", () => {
    const html = renderToStaticMarkup(<ReactivatePeople notify={[ann, bo]} unbilled={[ann, bo]} />);
    expect(text(html, "reactivate-notify")).toBe("Ann Lee and Bo Diaz, who were on it when it was canceled, and the vendor.");
    expect(html).toContain("Late-cancel pay canceled");
    expect(text(html, "reactivate-late-cancel")).toMatch(/^Ann Lee and Bo Diaz\. /);
    expect(html).not.toMatch(/waive/i);
  });

  test("no late-cancel list when nobody is owed late-cancel pay", () => {
    const html = renderToStaticMarkup(<ReactivatePeople notify={[ann]} unbilled={[]} />);
    expect(html).not.toContain("Late-cancel pay canceled");
  });
});
