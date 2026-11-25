import { describe, expect, test } from "vitest";
import { imageRefs, parseMarkdown } from "@/domain/manuals/markdown";
import { chapterSlug, manualsFor, safeImageName } from "@/domain/manuals/manuals";
import { captureRefusal } from "../../../scripts/capture/guard";

describe("manual Markdown", () => {
  const md = [
    "# Billing a detail",
    "",
    "Bill a detail after its **end time**. See [Locks](locks.md).",
    "",
    "1. Open **Billing**.",
    "",
    "   ![Billing list](../images/deputy/09-billing-1-phone.webp)",
    "",
    "2. Choose `Bill`.",
    "   It opens the bill form.",
    "",
    "## Good to know",
    "",
    "- One item",
    "- Two items",
    "",
    "> Nothing is billed before the end time.",
    "",
  ].join("\n");

  test("parses headings, paragraphs, numbered steps with images, bullets and notes", () => {
    const blocks = parseMarkdown(md);
    expect(blocks.map((b) => b.type)).toEqual(["heading", "paragraph", "list", "heading", "list", "note"]);
    expect(blocks[0]).toEqual({ type: "heading", level: 1, text: "Billing a detail" });
    expect(blocks[1]).toEqual({
      type: "paragraph",
      inline: [
        { t: "text", v: "Bill a detail after its " },
        { t: "strong", v: "end time" },
        { t: "text", v: ". See " },
        { t: "link", v: "Locks", href: "locks.md" },
        { t: "text", v: "." },
      ],
    });
    const steps = blocks[2];
    expect(steps).toMatchObject({ type: "list", ordered: true });
    if (steps.type !== "list") throw new Error("not a list");
    expect(steps.items).toHaveLength(2);
    expect(steps.items[0]).toEqual([
      { type: "paragraph", inline: [{ t: "text", v: "Open " }, { t: "strong", v: "Billing" }, { t: "text", v: "." }] },
      { type: "image", alt: "Billing list", src: "../images/deputy/09-billing-1-phone.webp" },
    ]);
    expect(steps.items[1]).toEqual([
      { type: "paragraph", inline: [{ t: "text", v: "Choose " }, { t: "code", v: "Bill" }, { t: "text", v: ". It opens the bill form." }] },
    ]);
    expect(blocks[4]).toMatchObject({ type: "list", ordered: false, items: [[{ type: "paragraph" }], [{ type: "paragraph" }]] });
    expect(blocks[5]).toEqual({ type: "note", inline: [{ t: "text", v: "Nothing is billed before the end time." }] });
  });

  test("lists every image, nested or not", () => {
    expect(imageRefs(parseMarkdown(md))).toEqual(["../images/deputy/09-billing-1-phone.webp"]);
  });
});

describe("manual access", () => {
  test("each role reads only its own manuals; staff read all three", () => {
    expect(manualsFor("personnel")).toEqual(["deputy"]);
    expect(manualsFor("vendor")).toEqual(["vendor"]);
    expect(manualsFor("coordinator")).toEqual(["deputy", "coordinator-admin", "vendor"]);
    expect(manualsFor("admin")).toEqual(["deputy", "coordinator-admin", "vendor"]);
  });

  test("chapter slugs drop the number; image names cannot leave the folder", () => {
    expect(chapterSlug("03-profile-and-w9.md")).toBe("profile-and-w9");
    expect(safeImageName("03-profile-1-phone.webp")).toBe(true);
    expect(safeImageName("../secret.webp")).toBe(false);
    expect(safeImageName("a/b.webp")).toBe(false);
    expect(safeImageName("x.svg")).toBe(false);
  });
});

describe("capture guard", () => {
  test("staging is allowed", () => {
    expect(captureRefusal({ appEnv: "staging", trainingBanner: false })).toBeNull();
  });
  test("production is allowed only while the session is in training", () => {
    expect(captureRefusal({ appEnv: "production", trainingBanner: true })).toBeNull();
    expect(captureRefusal({ appEnv: "production", trainingBanner: false })).toMatch(/^Refusing to capture/);
  });
  test("an unknown site is refused", () => {
    expect(captureRefusal({ appEnv: undefined, trainingBanner: false })).toMatch(/^Refusing to capture/);
  });
});
