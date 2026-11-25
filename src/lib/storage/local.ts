import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";
import type { Storage } from "./storage";

/** Writes objects under `dir`. Used in development and tests. */
export function createLocalStorage(dir: string): Storage {
  const root = resolve(dir);
  const pathFor = (key: string): string => {
    const p = resolve(root, key);
    if (!p.startsWith(root + sep)) throw new Error("Invalid storage key.");
    return p;
  };
  return {
    // Atomic: written to a temporary file in the same folder, then renamed over the target, so an interrupted write
    // (or a reader during one) never sees a truncated file.
    async put(key, body) {
      const p = pathFor(key);
      await mkdir(dirname(p), { recursive: true });
      const tmp = join(dirname(p), `.${basename(p)}.${randomBytes(6).toString("hex")}.tmp`);
      try {
        await writeFile(tmp, body);
        await rename(tmp, p);
      } catch (err) {
        await rm(tmp, { force: true });
        throw err;
      }
    },
    async get(key) {
      return readFile(pathFor(key));
    },
  };
}
