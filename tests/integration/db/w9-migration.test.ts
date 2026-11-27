import { cp, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { useTestDb } from "../../setup/test-db";
import { createDb } from "@/db/client";
import { migrationsFolder } from "@/db/migrate";

/** A copy of the migrations folder that stops before `tag`. */
async function foldersUpTo(tag: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "extra-duty-migrations-"));
  await cp(migrationsFolder, dir, { recursive: true });
  const journalPath = join(dir, "meta", "_journal.json");
  const journal = JSON.parse(await readFile(journalPath, "utf8")) as { entries: Array<{ tag: string }> };
  journal.entries = journal.entries.slice(0, journal.entries.findIndex((e) => e.tag === tag));
  await writeFile(journalPath, JSON.stringify(journal));
  return dir;
}

describe("the W-9 review migration on a populated database", () => {
  const get = useTestDb();

  test("every W-9 already on file becomes approved and grandfathered, with no signature date", async () => {
    const { db: main, url } = get();
    await main.execute(sql`create database w9_migration`);
    const db = createDb(url.replace(/\/test$/, "/w9_migration"));
    try {
      await migrate(db, { migrationsFolder: await foldersUpTo("0039_w9_review") });
      await db.execute(sql`insert into users (id, name, email) values ('u1', 'Old Deputy', 'old@example.test')`);
      await db.execute(sql`insert into files (id, storage_key, filename, content_type, size, encrypted, owner_user_id, kind)
        values ('f1', 'w9/a', 'W-9.pdf', 'application/pdf', 10, true, 'u1', 'w9'), ('f2', 'w9/b', 'W-9.pdf', 'application/pdf', 10, true, 'u1', 'w9')`);
      await db.execute(sql`insert into w9s (id, user_id, file_id, current) values ('w-old', 'u1', 'f1', false), ('w-cur', 'u1', 'f2', true)`);

      await migrate(db, { migrationsFolder });

      const rows = await db.execute<{ id: string; status: string; grandfathered: boolean; signed_on: string | null; current: boolean }>(
        sql`select id, status, grandfathered, signed_on, current from w9s order by id`,
      );
      expect(rows.rows).toEqual([
        { id: "w-cur", status: "approved", grandfathered: true, signed_on: null, current: true },
        { id: "w-old", status: "approved", grandfathered: true, signed_on: null, current: false },
      ]);
      // New uploads after the update start pending.
      await db.execute(sql`insert into files (id, storage_key, filename, content_type, size, encrypted, owner_user_id, kind) values ('f3', 'w9/c', 'W-9.pdf', 'application/pdf', 10, true, 'u1', 'w9')`);
      await db.execute(sql`insert into w9s (id, user_id, file_id, current) values ('w-new', 'u1', 'f3', false)`);
      const [fresh] = (await db.execute<{ status: string; grandfathered: boolean }>(sql`select status, grandfathered from w9s where id = 'w-new'`)).rows;
      expect(fresh).toEqual({ status: "pending", grandfathered: false });
    } finally {
      await db.$client.end();
    }
  });
});
