import { describe, expect, test } from "vitest";
import { sql } from "drizzle-orm";
import { useTestDb } from "../../setup/test-db";

describe("indexes", () => {
  const get = useTestDb();

  test("invoices are indexed by payee (earnings, tax and the deputy's invoice lists)", async () => {
    const r = await get().db.execute(sql`select indexdef from pg_indexes where tablename = 'invoices' and indexname = 'invoices_payee_idx'`);
    expect((r.rows[0] as { indexdef: string } | undefined)?.indexdef).toMatch(/\(payee_user_id\)/);
  });
});
