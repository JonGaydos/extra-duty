import { describe, expect, test } from "vitest";
import { redact } from "@/domain/export/export";

const hidden = (key: string) => (redact({ [key]: "x" }) as Record<string, unknown>)[key] === "[hidden]";

describe("the export hides secret fields", () => {
  test("keys that name a password, secret, token or API key are hidden anywhere in the name", () => {
    for (const key of ["password", "smtpPassword", "clientSecret", "secretKey", "accessToken", "tokenHash", "apiKey", "emailApiKey", "APIKEY"]) expect(hidden(key), key).toBe(true);
  });

  test("keys that end in enc are hidden", () => {
    for (const key of ["urlEnc", "smtpPassEnc", "keyEnc"]) expect(hidden(key), key).toBe(true);
  });

  test("other keys stay visible, including ones with enc not at the end", () => {
    for (const key of ["name", "email", "encodedName", "encryptedAt", "frequency", "api", "key", "pass"]) expect(hidden(key), key).toBe(false);
  });

  test("nested objects and arrays are redacted, and empty or non-text values are kept", () => {
    expect(redact({ settings: { smtpPassword: "p", host: "h" }, list: [{ token: "t" }], password: "", apiKey: null })).toEqual({
      settings: { smtpPassword: "[hidden]", host: "h" },
      list: [{ token: "[hidden]" }],
      password: "",
      apiKey: null,
    });
  });
});
