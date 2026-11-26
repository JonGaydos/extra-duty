import { currentMode, type DataMode } from "@/db/client";
import { appEnvFromProcess } from "@/lib/env";
import { createLocalStorage } from "./local";
import { createS3Storage } from "./s3";
import type { Storage } from "./storage";

export type { Storage } from "./storage";

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set.`);
  return v;
}

/**
 * Builds a storage adapter from env. `bucketOrDir` overrides the S3 bucket or
 * the local directory so a second instance (training mode) can be created.
 */
export function createStorage(bucketOrDir?: string): Storage {
  const configured = process.env.STORAGE_DRIVER;
  if (!configured && appEnvFromProcess() === "production") {
    throw new Error('STORAGE_DRIVER is not set. In production set it to "s3" (or "local" deliberately).');
  }
  const driver = configured ?? "local";
  if (driver === "local") {
    return createLocalStorage(bucketOrDir ?? process.env.STORAGE_LOCAL_DIR ?? "./var/storage");
  }
  if (driver === "s3") {
    return createS3Storage({
      endpoint: process.env.S3_ENDPOINT,
      region: required("S3_REGION"),
      bucket: bucketOrDir ?? required("S3_BUCKET"),
      accessKeyId: required("S3_ACCESS_KEY_ID"),
      secretAccessKey: required("S3_SECRET_ACCESS_KEY"),
    });
  }
  throw new Error(`STORAGE_DRIVER must be "s3" or "local", got "${driver}".`);
}

/**
 * Where `mode`'s files live. Training has its own: the TRAINING_BUCKET bucket (S3), or TRAINING_STORAGE_LOCAL_DIR
 * (local, default ./var/training-storage). It is never the live bucket or directory.
 */
function trainingLocation(): string {
  const driver = process.env.STORAGE_DRIVER ?? "local";
  if (driver === "s3") {
    const bucket = required("TRAINING_BUCKET");
    if (bucket === process.env.S3_BUCKET) throw new Error("TRAINING_BUCKET must not be the live bucket (S3_BUCKET).");
    return bucket;
  }
  const dir = process.env.TRAINING_STORAGE_LOCAL_DIR ?? "./var/training-storage";
  if (dir === (process.env.STORAGE_LOCAL_DIR ?? "./var/storage")) throw new Error("TRAINING_STORAGE_LOCAL_DIR must not be the live directory.");
  return dir;
}

const shared: Partial<Record<DataMode, Storage>> = {};

/** The storage for `mode`, created on first use. */
export function storageFor(mode: DataMode): Storage {
  shared[mode] ??= mode === "live" ? createStorage() : createStorage(trainingLocation());
  return shared[mode];
}

/** The storage of the current mode (see runInMode), used by domain services. */
export function getStorage(): Storage {
  return storageFor(currentMode());
}
