import { describe, expect, test } from "vitest";
import { formatPhone, formatPhoneInput, phoneDigits } from "@/lib/phone";

/** Types `text` one character at a time at the end, the way a person would. */
function type(text: string, start = "") {
  let value = start;
  for (const ch of text) {
    const next = value + ch;
    value = formatPhoneInput(value, next, next.length).value;
  }
  return value;
}

describe("phone formatting", () => {
  test("typing ten digits shows ###-###-####", () => {
    expect(type("5555555555")).toBe("555-555-5555");
    expect(type("5555")).toBe("555-5");
    expect(type("555555")).toBe("555-555");
    expect(type("5555555")).toBe("555-555-5");
  });

  test("an eleventh digit is ignored, and letters never appear", () => {
    expect(type("55555555559")).toBe("555-555-5555");
    expect(type("55a5")).toBe("555");
  });

  test("pasting any common format", () => {
    for (const pasted of ["(555) 555-5555", "+1 555 555 5555", "1-555-555-5555", "555.555.5555"]) {
      expect(formatPhoneInput("", pasted, pasted.length)).toEqual({ value: "555-555-5555", cursor: 12 });
    }
  });

  test("the cursor stays after the digit just typed, even when a dash is inserted", () => {
    // Typing the 4th digit at the end adds a dash before it: the cursor goes after the new digit.
    expect(formatPhoneInput("555", "5551", 4)).toEqual({ value: "555-1", cursor: 5 });
    // Typing in the middle: "555-|555" + "9" -> "555-955-5", cursor after the 9.
    expect(formatPhoneInput("555-555", "555-9555", 5)).toEqual({ value: "555-955-5", cursor: 5 });
  });

  test("backspace over a dash deletes the digit before it", () => {
    // "555-555-5555" with the cursor after the second dash; backspace removes the dash in the raw value.
    expect(formatPhoneInput("555-555-5555", "555-5555555", 7)).toEqual({ value: "555-555-555", cursor: 6 });
    expect(formatPhoneInput("555-1", "5551", 3)).toEqual({ value: "551", cursor: 2 });
  });

  test("deleting a digit keeps the cursor where it was", () => {
    expect(formatPhoneInput("555-123-4567", "555-13-4567", 5)).toEqual({ value: "555-134-567", cursor: 5 });
  });

  test("digits drop a leading US country code only when there are eleven", () => {
    expect(phoneDigits("+1 (555) 555-5555")).toBe("5555555555");
    expect(phoneDigits("1555555555")).toBe("1555555555");
    expect(formatPhone("5555555555")).toBe("555-555-5555");
  });
});

describe("the saved phone rule", async () => {
  const { cleanPhone } = await import("@/domain/phone");
  test("blank clears; any common format is stored as ###-###-####", () => {
    expect(cleanPhone("  ")).toBeNull();
    expect(cleanPhone(null)).toBeNull();
    expect(cleanPhone("8505550148")).toBe("850-555-0148");
    expect(cleanPhone("+1 (850) 555-0148")).toBe("850-555-0148");
  });

  test("anything but 10 US digits is refused", () => {
    for (const bad of ["555-0100", "999", "2 850 555 0148", "850555014812"]) expect(() => cleanPhone(bad)).toThrow("Enter a 10-digit phone number");
  });
});
