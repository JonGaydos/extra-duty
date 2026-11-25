import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test, vi } from "vitest";

vi.mock("@/app/(app)/profile/actions", () => ({}));
vi.mock("@/app/(app)/_personnel/actions", () => ({}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));

const { AlertPrefs } = await import("@/app/(app)/profile/forms");

const types = [
  { type: "job.changed", label: "A detail you are on changes" },
  { type: "billing.ready", label: "A detail is ready to bill" },
];

describe("personal alert choices under the agency's switches", () => {
  test("a channel the agency turned off is disabled, unchecked and says so", () => {
    const html = renderToStaticMarkup(<AlertPrefs types={types} prefs={{}} agencyOff={{ "job.changed": { email: true, push: false } }} />);
    expect(html).toContain("Turned off by your agency: email");
    const email = /<input[^>]*aria-label="Email: A detail you are on changes[^"]*"[^>]*>/.exec(html)?.[0] ?? "";
    expect(email).toContain("disabled");
    expect(email).not.toContain("checked");
    expect(email).toContain("Turned off by your agency");
    const push = /<input[^>]*aria-label="Push: A detail you are on changes"[^>]*>/.exec(html)?.[0] ?? "";
    expect(push).toContain("checked");
    // A type with nothing off has no note.
    expect(html.match(/Turned off by your agency:/g)).toHaveLength(1);
  });
});
