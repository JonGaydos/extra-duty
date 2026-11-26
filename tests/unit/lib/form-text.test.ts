import { describe, expect, test } from "vitest";
import { formText } from "@/lib/form-text";
import { scalarText } from "@/lib/text";

describe("formText", () => {
  test("reads text fields and treats missing fields and files as empty", () => {
    const form = new FormData();
    form.set("email", " a@b.example ");
    form.set("upload", new Blob(["x"]), "x.txt");
    expect(formText(form, "email")).toBe(" a@b.example ");
    expect(formText(form, "missing")).toBe("");
    expect(formText(form, "upload")).toBe("");
  });
});

describe("scalarText", () => {
  test("writes plain values as text and never prints an object", () => {
    expect(scalarText("555-0100")).toBe("555-0100");
    expect(scalarText(12)).toBe("12");
    expect(scalarText(false)).toBe("false");
    expect(scalarText(null)).toBe("");
    expect(scalarText(undefined)).toBe("");
    expect(scalarText({ a: 1 })).toBe("");
  });
});
