import type { Metadata } from "next";
import Link from "next/link";
import { inArray } from "drizzle-orm";
import { withTx } from "@/ui/shell/request";
import { users } from "@/db/schema";
import { listApiKeys } from "@/domain/api-keys/api-keys";
import { PageTitle } from "../../_personnel/TabLinks";
import { dateLabel, dateTime } from "../../_personnel/format";
import { systemActor } from "../_admin/session";
import { ApiReference } from "./ApiReference";
import { CreateKey, KeyList, type KeyRow } from "./ApiKeys";

export const metadata: Metadata = { title: "API access" };

/** Admins only: make and revoke API keys, and read the API reference. */
export default async function ApiPage() {
  const actor = await systemActor();
  const now = new Date();
  const rows: KeyRow[] = await withTx(async (tx) => {
    const keys = await listApiKeys(actor, tx);
    const ids = [...new Set(keys.map((k) => k.createdBy))];
    const names = new Map(ids.length ? (await tx.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, ids))).map((u) => [u.id, u.name]) : []);
    return keys.map((k) => ({
      id: k.id,
      name: k.name,
      prefix: k.prefix,
      scopes: k.scopes,
      createdBy: names.get(k.createdBy) ?? "an admin",
      created: dateLabel(k.createdAt),
      lastUsed: k.lastUsedAt ? dateTime(k.lastUsedAt) : null,
      expires: k.expiresAt ? dateLabel(k.expiresAt) : null,
      expired: k.expiresAt !== null && k.expiresAt.getTime() <= now.getTime(),
      revoked: k.revokedAt ? dateLabel(k.revokedAt) : null,
    }));
  });
  return (
    <div className="flex flex-col gap-4.5">
      <p className="m-0 text-sm">
        <Link href="/admin/system">System</Link>
      </p>
      <PageTitle sub="Keys let other systems read and change Extra Duty data through the REST API. Admins only.">API access</PageTitle>
      <div className="grid items-start gap-4.5 md:grid-cols-[minmax(0,380px)_minmax(0,1fr)]">
        <CreateKey />
        <KeyList rows={rows} />
      </div>
      <ApiReference />
    </div>
  );
}
