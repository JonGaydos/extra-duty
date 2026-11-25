import { eq } from "drizzle-orm";
import { fileURLToPath } from "node:url";
import { createDb, type Db, type Tx } from "./client";
import { seedBuiltInReports } from "../domain/reports/saved";
import {
  jobTypes,
  notePresets,
  paymentMethods,
  positionTypes,
  qualifications,
  ranks,
  seasons,
  users,
} from "./schema";

const RANKS = [
  { name: "Posse", sortOrder: 1, inLadder: true },
  { name: "CSO", sortOrder: 2, inLadder: true },
  { name: "Deputy Sheriff", sortOrder: 3, inLadder: true },
  { name: "Dispatcher", sortOrder: 4, inLadder: false },
];

const QUALIFICATIONS = ["Incident Commander", "School Resource Deputy", "K9", "Motors"];

const POSITION_TYPES: {
  name: string;
  ranks: string[];
  requires?: string[];
  isIncidentCommander?: boolean;
  vendorRequestable: boolean;
}[] = [
  { name: "Posse", ranks: ["Posse", "CSO", "Deputy Sheriff"], vendorRequestable: true },
  { name: "CSO", ranks: ["CSO", "Deputy Sheriff"], vendorRequestable: true },
  { name: "Deputy Sheriff", ranks: ["Deputy Sheriff"], vendorRequestable: true },
  {
    name: "Incident Commander",
    ranks: ["Posse", "CSO", "Deputy Sheriff"],
    requires: ["Incident Commander"],
    isIncidentCommander: true,
    vendorRequestable: true,
  },
  { name: "Dispatcher", ranks: ["Dispatcher"], vendorRequestable: true },
  {
    name: "School Resource Deputy",
    ranks: ["Deputy Sheriff"],
    requires: ["School Resource Deputy"],
    vendorRequestable: true,
  },
];

const JOB_TYPES = ["Basic Security", "Traffic Control", "County Permitted Event"];
const PAYMENT_METHODS = ["Check handed to deputy", "Check mailed", "Cash", "Ramp", "Bill.com", "Other"];

const NOTE_PRESETS: Record<(typeof notePresets.$inferInsert)["context"], string[]> = {
  vendor_paid: ["Paid by check", "Paid by card", "Paid in cash"],
  deputy_paid: ["Received check from vendor", "Received cash from vendor", "Received payment by direct deposit"],
  report_nonpayment: ["Vendor has not paid after repeated requests", "Vendor refused to pay", "Unable to reach vendor"],
  issue_note: ["Called vendor, left message", "Vendor promised payment this week", "Awaiting vendor reply"],
  waiting_on: ["Waiting on vendor to send payment", "Waiting on deputy to confirm receipt", "Waiting on coordinator review"],
  send_back: ["Hours do not match the job record", "Missing receipt or proof of payment", "Rate is incorrect"],
};

/** Idempotent: safe to run any number of times. Existing rows are never modified. */
export async function seed(db: Db, opts: { adminEmail?: string } = {}): Promise<void> {
  await db.transaction((tx) => seedInTx(tx, opts));
}

/** The built-in seed inside the caller's transaction. */
export async function seedInTx(tx: Tx, opts: { adminEmail?: string } = {}): Promise<void> {
  {
    await tx.insert(ranks).values(RANKS).onConflictDoNothing({ target: ranks.name });
    await tx
      .insert(qualifications)
      .values(QUALIFICATIONS.map((name) => ({ name })))
      .onConflictDoNothing({ target: qualifications.name });

    const rankId = new Map((await tx.select().from(ranks)).map((r) => [r.name, r.id]));
    const qualId = new Map((await tx.select().from(qualifications)).map((q) => [q.name, q.id]));

    await tx
      .insert(positionTypes)
      .values(
        POSITION_TYPES.map((p, i) => ({
          name: p.name,
          eligibleRankIds: p.ranks.map((r) => rankId.get(r)!),
          requiredQualificationIds: (p.requires ?? []).map((q) => qualId.get(q)!),
          isIncidentCommander: p.isIncidentCommander ?? false,
          vendorRequestable: p.vendorRequestable,
          // Incident Commanders earn $25.00 an hour over the detail's rate; coordinators change it in Management.
          rateDifferentialCents: p.isIncidentCommander ? 2500 : 0,
          sortOrder: i + 1,
        })),
      )
      .onConflictDoNothing({ target: positionTypes.name });

    await tx
      .insert(jobTypes)
      .values(JOB_TYPES.map((name, i) => ({ name, sortOrder: i + 1 })))
      .onConflictDoNothing({ target: jobTypes.name });
    await tx
      .insert(paymentMethods)
      .values(PAYMENT_METHODS.map((name, i) => ({ name, sortOrder: i + 1 })))
      .onConflictDoNothing({ target: paymentMethods.name });

    // Presets have no unique name; seed a context only while it has no presets at all.
    for (const [context, texts] of Object.entries(NOTE_PRESETS) as [keyof typeof NOTE_PRESETS, string[]][]) {
      const have = await tx.select({ id: notePresets.id }).from(notePresets).where(eq(notePresets.context, context));
      if (have.length === 0) {
        await tx.insert(notePresets).values(texts.map((text, i) => ({ context, text, sortOrder: i + 1 })));
      }
    }

    const existingSeason = await tx.select({ id: seasons.id }).from(seasons).where(eq(seasons.name, "All year"));
    if (existingSeason.length === 0) {
      await tx.insert(seasons).values({
        name: "All year",
        startMonthDay: "01-01",
        endMonthDay: "12-31",
        rollingCapMinutes: 960,
        weekCapMinutes: null,
        monthCapMinutes: null,
      });
    }

    await seedBuiltInReports(tx);

    if (opts.adminEmail) {
      const email = opts.adminEmail.trim().toLowerCase();
      const existing = await tx
        .select({ id: users.id })
        .from(users)
        .where(eq(users.email, email));
      if (existing.length === 0) {
        await tx.insert(users).values({ name: "Administrator", email, emailVerified: true, role: "admin" });
      }
    }
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL is not set");
    process.exit(1);
  }
  const db = createDb(url);
  try {
    if (!process.env.SEED_ADMIN_EMAIL) console.warn("db:seed: SEED_ADMIN_EMAIL not set; no admin created");
    await seed(db, { adminEmail: process.env.SEED_ADMIN_EMAIL });
    console.log("db:seed: done");
  } finally {
    await db.$client.end();
  }
}
