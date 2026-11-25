/**
 * Demo accounts and sample details for the local preview (scripts/preview.sh).
 * Idempotent: anything already present is left alone. Uses the domain services;
 * the direct writes are the invite row (because invite tokens are otherwise
 * only emailed; acceptInvite then sets each password) and marking the sample details open for sign-up.
 * Reads DATABASE_URL from the environment. The shared demo password is stored
 * only in .local-preview/demo-accounts.txt.
 */
import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { and, eq, inArray } from "drizzle-orm";
import { db, withTx } from "@/db/client";
import { assignments, invites, jobPositions, jobs, positionTypes, qualifications, ranks, users, vendors, jobTypes } from "@/db/schema";
import type { Actor } from "@/domain/actor";
import { acceptInvite } from "@/domain/auth/invites";
import { createUser } from "@/domain/users/users";
import { addLocation, createVendor, createVendorLogin } from "@/domain/vendors/vendors";
import { createJob, releaseJob, type JobInput } from "@/domain/jobs/jobs";
import { joinBackup, signUp } from "@/domain/assignments/signup";
import { getSettings } from "@/domain/settings/settings";
import { stopBoss } from "@/jobs/boss";

const FILE = join(process.cwd(), ".local-preview", "demo-accounts.txt");
const DOMAIN = "preview.test";
const em = (local: string) => `${local}@${DOMAIN}`;

type Row = { email: string; name: string; role: string; note: string };
const rows: Row[] = [];

function readPassword(): string | null {
  if (!existsSync(FILE)) return null;
  const m = readFileSync(FILE, "utf8").match(/^Password: (.+)$/m);
  return m ? m[1] : null;
}
const stored = readPassword();
const password = stored ?? randomBytes(9).toString("base64url") + "-Demo7";
// Saved before any account exists, so an interrupted run cannot leave accounts with a lost password.
if (!stored) writeFileSync(FILE, `Demo accounts (local preview only)\nPassword: ${password}\n`, { mode: 0o600 });

async function setPassword(userId: string): Promise<void> {
  const token = randomBytes(32).toString("base64url");
  await db.insert(invites).values({
    userId,
    tokenHash: createHash("sha256").update(token).digest("hex"),
    expiresAt: new Date(Date.now() + 3_600_000),
  });
  await acceptInvite(token, password);
}

async function userByEmail(email: string) {
  const [u] = await db.select().from(users).where(eq(users.email, email));
  return u;
}
const actorOf = (u: { id: string; role: Actor["role"]; rankId: string | null }, vendorId: string | null = null): Actor => ({
  userId: u.id,
  role: u.role,
  rankId: u.rankId,
  vendorId,
});

async function main() {
  const [dsRank] = await db.select().from(ranks).where(eq(ranks.name, "Deputy Sheriff"));
  const [csoRank] = await db.select().from(ranks).where(eq(ranks.name, "CSO"));
  const [icQual] = await db.select().from(qualifications).where(eq(qualifications.name, "Incident Commander"));

  // Admin: created by the seed (SEED_ADMIN_EMAIL); give it a name and a password.
  let admin = await userByEmail(em("admin"));
  if (!admin) throw new Error("Admin missing; run the seed with SEED_ADMIN_EMAIL=admin@" + DOMAIN);
  const adminActor = actorOf(admin);

  async function ensure(local: string, name: string, role: Actor["role"], rankId: string | null, qualificationIds: string[] = []) {
    let u = await userByEmail(em(local));
    if (!u) {
      u = await withTx((tx) =>
        createUser(adminActor, tx, { email: em(local), name, phone: null, role, rankId, badgeNumber: null, qualificationIds }),
      );
      await setPassword(u.id);
    }
    return u;
  }

  if (!(await db.select().from(users).where(eq(users.id, admin.id)))[0]!.twoFactorEnabled) {
    await setPassword(admin.id);
  }
  await db.update(users).set({ name: "Avery Admin" }).where(eq(users.id, admin.id));
  const coord = await ensure("coordinator", "Casey Coordinator", "coordinator", null);
  const dep = await ensure("deputy", "Devon Deputy", "personnel", dsRank.id, [icQual.id]);
  const cso = await ensure("cso", "Corey Community", "personnel", csoRank.id);
  const coordActor = actorOf(coord);

  // Vendor with one location and one login.
  let [vendor] = await db.select().from(vendors).where(eq(vendors.name, "Sample Brewing Company"));
  if (!vendor) {
    vendor = await withTx((tx) =>
      createVendor(coordActor, tx, {
        name: "Sample Brewing Company",
        typeId: null,
        contactName: "Riley Sample",
        phone: "555-0100",
        billingEmails: [em("billing")],
        defaultRateCents: 5500,
        notes: "Demo vendor for the local preview.",
      }),
    );
    await withTx((tx) => addLocation(coordActor, tx, vendor.id, { name: "Taproom", address: "100 Example Street, Sampleville" }));
  }
  let vuser = await userByEmail(em("vendor"));
  if (!vuser) {
    vuser = await withTx((tx) => createVendorLogin(coordActor, tx, vendor.id, { email: em("vendor"), name: "Riley Sample" }));
    await setPassword(vuser.id);
  }
  const [location] = await withTx((tx) => tx.query.vendorLocations.findMany({ where: (l, { eq }) => eq(l.vendorId, vendor.id) }));

  // Sample details: each is created only if its title is missing, so a partial run can be finished.
  {
    const [type] = await db.select().from(jobTypes).where(eq(jobTypes.name, "Basic Security"));
    const ptByName = new Map((await db.select().from(positionTypes)).map((p) => [p.name, p.id]));
    const warningVersion = (await withTx((tx) => getSettings(tx))).signupWarningVersion;
    const day = (n: number, h: number, m = 0) => {
      const d = new Date();
      d.setUTCDate(d.getUTCDate() + n);
      d.setUTCHours(h, m, 0, 0);
      return d;
    };
    const base = { vendorId: vendor.id, locationId: location?.id ?? null, typeId: type.id, rateCents: null, opsPlanRequired: false, opsPlanDueAt: null, held: false, description: null, notes: null, contactName: "Riley Sample", contactPhone: "555-0100" } satisfies Partial<JobInput>;
    const mk = async (input: Partial<JobInput> & Pick<JobInput, "title" | "startAt" | "endAt">) => {
      const [have] = await db.select().from(jobs).where(and(eq(jobs.vendorId, vendor.id), eq(jobs.title, input.title)));
      return have ?? withTx((tx) => createJob(coordActor, tx, { ...base, ...input }));
    };
    const pos = (name: string, count = 1) => [{ positionTypeId: ptByName.get(name)!, count }];

    await mk({ title: "Friday taproom security (open)", startAt: day(5, 23), endAt: day(6, 4), positions: pos("Deputy Sheriff", 2) });
    const full = await mk({ title: "Saturday night event (full, with backup)", startAt: day(6, 23), endAt: day(7, 4), positions: pos("CSO") });
    await mk({
      title: "Weekday lot patrol (flexible times)",
      startAt: day(8, 22),
      endAt: day(9, 2),
      positions: pos("CSO"),
      flex: { earliestStartAt: day(8, 21), latestEndAt: day(9, 4), allowShorter: true },
    });
    await mk({
      title: "Holiday market traffic control (safety notes)",
      startAt: day(10, 15),
      endAt: day(10, 21),
      positions: pos("Deputy Sheriff"),
      safety: {
        notes: "Crowds expected at the east gate. Known trespasser banned from the property; call dispatch before contact.",
        addresses: [{ address: "100 Example Street, Sampleville", description: "East gate", lat: null, lng: null }],
      },
    });

    // The details are a week or so out, so they may fall in a month whose release time has not come: the
    // coordinator uses Release now, the same button as on the detail page.
    for (const j of await db.select({ id: jobs.id }).from(jobs).where(and(eq(jobs.vendorId, vendor.id), inArray(jobs.state, ["scheduled", "active"])))) {
      await withTx((tx) => releaseJob(coordActor, tx, j.id, { scope: "one", now: true }));
    }

    const [fullPos] = await db.select().from(jobPositions).where(eq(jobPositions.jobId, full.id));
    const input = { warningVersion, jobId: full.id };
    const [anyone] = await db.select({ id: assignments.id }).from(assignments).where(eq(assignments.jobId, full.id));
    if (!anyone) {
      await withTx((tx) => signUp(actorOf(cso), tx, fullPos.id, input));
      await withTx((tx) => joinBackup(actorOf(dep), tx, fullPos.id, input));
    }
  }

  if (process.env.DEMO_RESET_PASSWORDS === "1") for (const u of [admin, coord, dep, cso, vuser]) await setPassword(u.id);

  const note = (e: string) => (e === em("deputy") ? "Deputy Sheriff, Incident Commander" : e === em("cso") ? "CSO" : e === em("vendor") ? "Sample Brewing Company" : "");
  admin = (await userByEmail(em("admin")))!;
  for (const u of [admin, coord, dep, cso, vuser]) rows.push({ email: u.email, name: u.name, role: u.role, note: note(u.email) });
  writeFileSync(
    FILE,
    ["Demo accounts (local preview only)", `Password: ${password}`, "", ...rows.map((r) => `${r.email}  ${r.role}  ${r.name}  ${r.note}`.trimEnd()), ""].join("\n"),
    { mode: 0o600 },
  );
}

try {
  await main();
} finally {
  await stopBoss().catch(() => {});
  await db.$client.end();
}
