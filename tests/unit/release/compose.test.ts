import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { parse } from "yaml";

type Service = {
  image?: string;
  env_file?: string[];
  environment?: Record<string, string>;
  volumes?: string[];
};
type Compose = { services: Record<string, Service>; volumes: Record<string, unknown> };

const compose = parse(readFileSync("docker-compose.yml", "utf8"), { merge: true }) as Compose;
const appServices = ["migrate", "web", "worker"] as const;

/** Self-hosted file storage is a folder on disk shared by the app containers; MinIO is gone. */
describe("docker-compose.yml file storage", () => {
  test("has no MinIO service, image, volume or setting", () => {
    expect(Object.keys(compose.services).sort((a, b) => a.localeCompare(b))).toEqual(["caddy", "migrate", "postgres", "web", "worker"]);
    for (const s of Object.values(compose.services)) expect(s.image ?? "").not.toMatch(/minio/i);
    expect(Object.keys(compose.volumes)).not.toContain("minio-data");
    expect(readFileSync("docker-compose.yml", "utf8")).not.toMatch(/minio|bucket/i);
    expect(readFileSync(".env.example", "utf8")).not.toMatch(/MINIO/);
  });

  test("web, the worker and migrate mount the same files folder at /data", () => {
    expect(compose.volumes).toHaveProperty("files");
    const mounts = appServices.map((name) => compose.services[name].volumes?.find((v) => v.endsWith(":/data")));
    expect(mounts[0]).toBe("${FILES_PATH:-files}:/data");
    expect(new Set(mounts).size).toBe(1);
    for (const name of appServices) expect(compose.services[name].environment?.FILES_MOUNT).toBe("/data");
  });

  test("disk storage is the default, and app.env is read after it so it can choose S3", () => {
    for (const name of appServices) {
      const s = compose.services[name];
      expect(s.env_file).toEqual(["docker/storage.env", "app.env"]);
      // environment wins over env_file, so no storage setting may be set there.
      expect(Object.keys(s.environment ?? {}).filter((k) => /^(STORAGE_|TRAINING_STORAGE|S3_|TRAINING_BUCKET)/.test(k))).toEqual([]);
    }
    const defaults = Object.fromEntries(
      readFileSync("docker/storage.env", "utf8")
        .split("\n")
        .filter((l) => /^[A-Z_]+=/.test(l))
        .map((l) => l.split("=") as [string, string]),
    );
    expect(defaults).toEqual({ STORAGE_DRIVER: "local", STORAGE_LOCAL_DIR: "/data/live", TRAINING_STORAGE_LOCAL_DIR: "/data/training" });
  });
});

/** The entry point's storage step, run with an unknown ROLE so it stops right after it. */
describe("docker-entrypoint.sh storage folders", () => {
  const run = (env: Record<string, string>) => {
    const base: NodeJS.ProcessEnv = { ...process.env, ROLE: "none" };
    for (const k of ["FILES_MOUNT", "STORAGE_DRIVER", "STORAGE_LOCAL_DIR", "TRAINING_STORAGE_LOCAL_DIR"]) delete base[k];
    return spawnSync("sh", ["scripts/docker-entrypoint.sh"], { env: { ...base, ...env }, encoding: "utf8" });
  };

  test("creates the live and training folders inside the mounted folder", () => {
    const mount = mkdtempSync(join(tmpdir(), "ed-files-"));
    const r = run({ FILES_MOUNT: mount, STORAGE_DRIVER: "local", STORAGE_LOCAL_DIR: `${mount}/live`, TRAINING_STORAGE_LOCAL_DIR: `${mount}/training` });
    expect(r.status).toBe(64); // past the storage step, refused only for the unknown role
    expect(statSync(join(mount, "live")).isDirectory()).toBe(true);
    expect(statSync(join(mount, "training")).isDirectory()).toBe(true);
  });

  test("refuses a storage folder outside the mounted folder", () => {
    const mount = mkdtempSync(join(tmpdir(), "ed-files-"));
    const r = run({ FILES_MOUNT: mount, STORAGE_DRIVER: "local", STORAGE_LOCAL_DIR: "./var/storage", TRAINING_STORAGE_LOCAL_DIR: `${mount}/training` });
    expect(r.status).toBe(78);
    expect(r.stderr).toMatch(/outside/);
  });

  test("skips the folders for S3 storage", () => {
    const r = run({ FILES_MOUNT: "/data", STORAGE_DRIVER: "s3", STORAGE_LOCAL_DIR: "/data/live" });
    expect(r.status).toBe(64);
  });
});
