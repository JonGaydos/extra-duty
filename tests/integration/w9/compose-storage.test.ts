import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, test } from "vitest";
import { useApiDb, bearer, call, sessionToken } from "../api/helpers";
import { makeUser } from "../users/helpers";
import type { Actor } from "@/domain/actor";
import { readW9 } from "@/domain/w9/w9";
import { createLocalStorage } from "@/lib/storage/local";
import { GET as myW9, POST as uploadMyW9 } from "@/app/api/v1/me/w9/route";

const PDF = Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.from("SSN 123-45-6789 ".repeat(20))]);

async function filesUnder(dir: string): Promise<string[]> {
  return (await readdir(dir, { recursive: true, withFileTypes: true })).filter((e) => e.isFile()).map((e) => join(e.parentPath, e.name));
}

/** The Docker Compose storage settings (docker/storage.env): disk storage in one mounted folder, /data/live and /data/training. */
describe("W-9 upload and download on Compose's disk storage", () => {
  const get = useApiDb();
  let mount: string;
  let token: string;
  let owner: Actor;

  beforeAll(async () => {
    mount = await mkdtemp(join(tmpdir(), "extra-duty-data-"));
    process.env.STORAGE_DRIVER = "local";
    process.env.STORAGE_LOCAL_DIR = join(mount, "live");
    process.env.TRAINING_STORAGE_LOCAL_DIR = join(mount, "training");
    const user = await makeUser(get().db, "personnel", "compose-w9@example.test");
    owner = user.actor;
    token = await sessionToken(get().db, user.row.id);
  });

  test("an uploaded W-9 is stored encrypted under the live folder and downloads as uploaded", async () => {
    const form = new FormData();
    form.set("file", new File([PDF], "w9.pdf", { type: "application/pdf" }));
    // A real browser upload: multipart body with its declared length (the route refuses one without it).
    const body = new Request("http://localhost", { method: "POST", body: form });
    const buf = Buffer.from(await body.arrayBuffer());
    const headers = { ...bearer(token), "content-type": body.headers.get("content-type")!, "content-length": String(buf.byteLength) };
    const up = await call(uploadMyW9, "/api/v1/me/w9", { method: "POST", headers, body: buf });
    expect(up.status).toBe(200);

    const stored = await filesUnder(join(mount, "live"));
    expect(stored).toHaveLength(1);
    const blob = await readFile(stored[0]);
    expect(blob.includes(Buffer.from("123-45-6789"))).toBe(false);

    const down = await call(myW9, "/api/v1/me/w9", { headers: bearer(token) });
    expect(down.status).toBe(200);
    expect(Buffer.from(await down.arrayBuffer()).equals(PDF)).toBe(true);
  });

  test("another container mounting the same folder (the worker) reads the same W-9", async () => {
    const worker = createLocalStorage(join(mount, "live"));
    const w9 = await get().db.transaction((tx) => readW9(owner, tx, owner.userId, worker));
    expect(w9.body.equals(PDF)).toBe(true);
  });
});
