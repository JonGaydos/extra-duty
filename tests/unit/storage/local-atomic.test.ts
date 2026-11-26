import { mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { createLocalStorage } from "@/lib/storage/local";

// A rotation or upload interrupted mid-write must never leave a truncated file: readers see the old bytes or the
// new bytes, whole, and nothing else is left in the folder.
test("a local put replaces a file atomically", async () => {
  const dir = await mkdtemp(join(tmpdir(), "extra-duty-atomic-"));
  const store = createLocalStorage(dir);
  const before = Buffer.alloc(1024 * 1024, "a");
  const after = Buffer.alloc(48 * 1024 * 1024, "b");
  await store.put("w9/one", before, "application/octet-stream");
  let done = false;
  const write = store.put("w9/one", after, "application/octet-stream").then(() => (done = true));
  while (!done) {
    const got = await store.get("w9/one");
    expect(got.length === before.length || got.length === after.length).toBe(true);
  }
  await write;
  expect((await store.get("w9/one")).equals(after)).toBe(true);
  expect(await readdir(join(dir, "w9"))).toEqual(["one"]);
});
