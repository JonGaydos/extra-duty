import { afterEach, expect, test } from "vitest";
import { createStorage } from "@/lib/storage";

const env = { ...process.env };
afterEach(() => {
  process.env = { ...env };
});

test("production without STORAGE_DRIVER throws", () => {
  process.env.APP_ENV = "production";
  delete process.env.STORAGE_DRIVER;
  expect(() => createStorage()).toThrow(/STORAGE_DRIVER/);
});

test("an unset APP_ENV counts as production, so a missing STORAGE_DRIVER throws", () => {
  delete process.env.APP_ENV;
  delete process.env.STORAGE_DRIVER;
  expect(() => createStorage()).toThrow(/STORAGE_DRIVER/);
});

test("non-production defaults to local; an explicit driver is honored in production", () => {
  process.env.APP_ENV = "staging";
  delete process.env.STORAGE_DRIVER;
  expect(() => createStorage()).not.toThrow();
  process.env.APP_ENV = "production";
  process.env.STORAGE_DRIVER = "local";
  expect(() => createStorage()).not.toThrow();
});
