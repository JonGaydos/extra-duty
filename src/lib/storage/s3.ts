import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import type { Storage } from "./storage";

export type S3Config = {
  endpoint?: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
};

/** Any S3-compatible service (such as AWS S3 or DigitalOcean Spaces). No host-specific code. */
export function createS3Storage(cfg: S3Config): Storage {
  const client = new S3Client({
    endpoint: cfg.endpoint || undefined,
    region: cfg.region,
    forcePathStyle: Boolean(cfg.endpoint),
    credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey },
  });
  return {
    async put(key, body, contentType) {
      await client.send(new PutObjectCommand({ Bucket: cfg.bucket, Key: key, Body: body, ContentType: contentType }));
    },
    async get(key) {
      const res = await client.send(new GetObjectCommand({ Bucket: cfg.bucket, Key: key }));
      if (!res.Body) throw new Error("Storage object has no body.");
      return Buffer.from(await res.Body.transformToByteArray());
    },
  };
}
