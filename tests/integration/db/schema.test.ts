import { afterAll, beforeAll, expect, test } from "vitest";
import { Client } from "pg";
import { startTestDb, type TestDb } from "../../setup/db";

let testDb: TestDb;
let client: Client;

async function insertJob(): Promise<{ jobId: string; positionId: string; userId: string }> {
  const id = () => crypto.randomUUID();
  const userId = id();
  const jobId = id();
  const positionId = id();
  const ptId = id();
  const vendorId = id();
  const typeId = id();
  await client.query(
    `insert into users (id, name, email, role, email_verified, created_at, updated_at)
     values ($1, 'U', $2, 'personnel', true, now(), now())`,
    [userId, `${userId}@example.com`],
  );
  await client.query(`insert into vendors (id, name, created_at, updated_at) values ($1, 'V', now(), now())`, [vendorId]);
  await client.query(`insert into job_types (id, name, created_at, updated_at) values ($1, $2, now(), now())`, [typeId, `t-${typeId}`]);
  await client.query(
    `insert into position_types (id, name, created_at, updated_at) values ($1, $2, now(), now())`,
    [ptId, `pt-${ptId}`],
  );
  await client.query(
    `insert into jobs (id, vendor_id, type_id, title, start_at, end_at, rate_cents, created_at, updated_at)
     values ($1, $2, $3, 'J', now(), now() + interval '4 hours', 5000, now(), now())`,
    [jobId, vendorId, typeId],
  );
  await client.query(
    `insert into job_positions (id, job_id, position_type_id, count, created_at, updated_at)
     values ($1, $2, $3, 1, now(), now())`,
    [positionId, jobId, ptId],
  );
  return { jobId, positionId, userId };
}

function insertAssignment(
  ids: { jobId: string; positionId: string; userId: string },
  status: string,
) {
  return client.query(
    `insert into assignments (id, job_id, job_position_id, user_id, status, created_at, updated_at)
     values ($1, $2, $3, $4, $5, now(), now())`,
    [crypto.randomUUID(), ids.jobId, ids.positionId, ids.userId, status],
  );
}

beforeAll(async () => {
  testDb = await startTestDb();
  client = new Client({ connectionString: testDb.url });
  await client.connect();
});

afterAll(async () => {
  await client?.end();
  await testDb?.stop();
});

test("migrations apply to an empty database", async () => {
  const res = await client.query(
    `select count(*)::int as n from information_schema.tables where table_schema = 'public'`,
  );
  expect(res.rows[0].n).toBeGreaterThan(40);
});

test("a second active assignment for the same job and user is rejected", async () => {
  const ids = await insertJob();
  await insertAssignment(ids, "signed_up");
  await expect(insertAssignment(ids, "backup")).rejects.toThrow(/duplicate key|unique/i);
});

test("a new assignment is allowed after the first is canceled", async () => {
  const ids = await insertJob();
  await insertAssignment(ids, "signed_up");
  await client.query(`update assignments set status = 'canceled' where job_id = $1`, [ids.jobId]);
  await insertAssignment(ids, "signed_up");
  const res = await client.query(`select count(*)::int as n from assignments where job_id = $1`, [ids.jobId]);
  expect(res.rows[0].n).toBe(2);
});
