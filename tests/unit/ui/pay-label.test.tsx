import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { PayLabel, payText } from "@/ui/components/PayLabel";

const text = (html: string) => html.replace(/<[^<>]+>/g, "");

describe("PayLabel", () => {
  test("shows the total and the hourly rate together", () => {
    expect(text(renderToStaticMarkup(<PayLabel totalCents={28000} rateCents={7000} />))).toBe("$280 at $70/hr");
    expect(text(renderToStaticMarkup(<PayLabel totalCents={45000} rateCents={7500} />))).toBe("$450 at $75/hr");
  });

  test("keeps cents when an amount is not whole dollars", () => {
    expect(payText(50625, 7250)).toBe("$506.25 at $72.50/hr");
    expect(payText(108750, 7500)).toBe("$1,087.50 at $75/hr");
  });
});
