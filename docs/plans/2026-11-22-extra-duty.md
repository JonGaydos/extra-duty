# Extra Duty Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the agency-run off-duty detail scheduling app described in the spec: vendors, jobs, release rules, first come first served sign-up with caps, backups, billing with emailed PDF invoices and W-9s, payment tracking and issues, ops plans, alerts, and a vendor portal, as a mobile-first web app with a REST API for a later native app.

**Architecture:** One Next.js (App Router) application. All business rules live in `src/domain/` as plain TypeScript: pure rule functions (no I/O) plus services that take an `Actor` and a database transaction and enforce authorization themselves. Web pages (server components and server actions) and the REST API (`src/app/api/v1/`) are thin callers of the same services, so the future native app gets identical behavior. Background work (release alerts, reminders, emails, push) runs on pg-boss in a worker process started from the same codebase.

**Tech Stack:** Node.js 24 LTS, npm, TypeScript (strict), Next.js 15, React 19, Tailwind CSS 4, Drizzle ORM with PostgreSQL 16, Better Auth (email and password, two-factor), pg-boss, Zod, @asteasolutions/zod-to-openapi, date-fns 4 with @date-fns/tz, Nodemailer, @react-pdf/renderer, @aws-sdk/client-s3, web-push, ical.js, Leaflet, Vitest, embedded-postgres (tests and local dev), Playwright (end to end).

**Spec:** `docs/specs/2026-11-22-extra-duty-design.md`

## Global Constraints

- Agency time zone is `America/Chicago`. Every rule that names a day, week, month or clock time (release, caps, billing unlock, reminders) is evaluated in agency time. Store instants as `timestamptz`.
- Money is integer cents (`Cents`). Durations are integer minutes (`Minutes`). No floating point for either.
- Rank ladder, lowest to highest: `Posse`, `CSO`, `Deputy Sheriff`; `Dispatcher` is a class outside the ladder. No Sergeant or Lieutenant ranks; special and supervisory roles are qualifications (flags). "X and higher" means ladder order >= X, so a higher rank can fill a lower rank's spot.
- Roles: `admin`, `coordinator`, `personnel`, `vendor`. Admin includes coordinator powers; coordinator includes personnel powers. The only admin-only areas are the email server (SMTP) and security settings.
- Authorization is enforced inside domain services, never only in UI or route code.
- Every mutation writes an audit entry (actor, action, entity, before, after, at).
- Nothing is hard-deleted: users, vendors and jobs are deactivated or canceled.
- W-9 files are encrypted by the app (AES-256-GCM) in addition to storage encryption; only the owner, coordinators and admins can read them; every read is audit-logged.
- No Active Directory or SSO. Two-factor required for every account, using only a 6-digit code emailed at sign-in (no authenticator apps); trusted devices stay signed in 30 days.
- The agency never processes payments. No payment processor dependencies.
- UI copy: plain, professional; no emojis.
- Commit messages: one-line imperative subject, no AI attribution.
- Defaults for the spec's open questions are settings (Task 4); changing a default never needs code.

## Review Focus

1. Two people take the last spot in the same second (the 4:00 PM release rush): exactly one gets it, the other is offered backup. Test in Task 18.
2. Daylight saving changes and overnight details (for example 8:00 PM Oct 31 to 6:00 AM Nov 1, 2026, which is 11 hours): durations, rolling 24-hour cap windows, release instants and billing unlock stay correct. Tests in Tasks 2, 16, 21.
3. Release day larger than the month (setting 31 in a 30-day month, or 29 to 31 in February): release falls on the month's last day, not an error or the next month. Test in Task 14.
4. A person edits billed times so end is before start, or the edit crosses midnight: rejected with a clear message, or computed across midnight respectively. Test in Task 21.
5. The SMTP server is down or the person ticks "attach W-9" with no W-9 on file: billing still records, the email retries from the queue and the person sees "not sent yet", and billing with the W-9 box ticked and no W-9 is refused before anything is recorded. Tests in Tasks 23 and 21.

---

## Phase 1: Foundation

### Task 1: Project scaffold and test harness

**Files:**
- Create: `package.json`, `tsconfig.json`, `next.config.ts`, `eslint.config.mjs`, `vitest.config.ts`, `.gitignore`, `.env.example`, `README.md`
- Create: `src/app/layout.tsx`, `src/app/page.tsx`
- Create: `tests/setup/db.ts` (embedded-postgres harness), `tests/unit/smoke.test.ts`

**Interfaces:**
- Produces: `npm run dev`, `npm run build`, `npm test` (Vitest), `npm run test:e2e` (Playwright), `npm run worker`, `npm run db:migrate`; `startTestDb(): Promise<{ url: string; stop(): Promise<void> }>` in `tests/setup/db.ts`.

- [ ] **Step 1:** `git init`; create the Next.js app with TypeScript strict, Tailwind 4, ESLint, `src/` layout, npm.
- [ ] **Step 2:** Add Vitest with two projects: `unit` (no DB) and `integration` (uses `startTestDb`, one database per test file, migrations applied).
- [ ] **Step 3:** Write `tests/unit/smoke.test.ts` asserting `1 + 1 === 2`, and `tests/integration/db-smoke.test.ts` asserting `select 1` returns 1 from the embedded database.
- [ ] **Step 4:** Run `npm test`. Expected: both pass.
- [ ] **Step 5:** Commit: `git commit -m "Scaffold Next.js app and test harness"`

### Task 2: Agency time helpers

**Files:**
- Create: `src/domain/time/agency-time.ts`
- Test: `tests/unit/time/agency-time.test.ts`

**Interfaces:**
- Produces:
  - `AGENCY_TZ = 'America/Chicago'`
  - `agencyDateParts(at: Date): { year: number; month: number; day: number; hour: number; minute: number }`
  - `agencyInstant(year: number, month: number, day: number, hour: number, minute: number): Date`
  - `minutesBetween(start: Date, end: Date): Minutes`
  - `agencyDayKey(at: Date): string` (`YYYY-MM-DD`)
  - `agencyWeekKey(at: Date, weekStartsOn: 0..6): string` (date key of the week's first day)
  - `agencyMonthKey(at: Date): string` (`YYYY-MM`)

- [ ] **Step 1: Write failing tests**

```ts
it('fall-back overnight detail is 11 hours', () => {
  const s = agencyInstant(2026, 11, 1, 20, 0), e = agencyInstant(2026, 11, 2, 6, 0);
  expect(minutesBetween(s, e)).toBe(660);
});
it('spring-forward day has 23 hours', () => {
  expect(minutesBetween(agencyInstant(2027, 3, 14, 0, 0), agencyInstant(2027, 3, 15, 0, 0))).toBe(1380);
});
it('week key respects week start', () => {
  const thu = agencyInstant(2026, 11, 26, 12, 0);
  expect(agencyWeekKey(thu, 0)).toBe('2026-11-22');
  expect(agencyWeekKey(thu, 1)).toBe('2026-11-23');
});
```

- [ ] **Step 2:** Run `npx vitest run tests/unit/time`. Expected: FAIL (module missing).
- [ ] **Step 3:** Implement with `@date-fns/tz` `TZDate`.
- [ ] **Step 4:** Run again. Expected: PASS.
- [ ] **Step 5:** Commit: `Add agency time helpers`

### Task 3: Database schema and migrations

**Files:**
- Create: `drizzle.config.ts`, `src/db/client.ts`, `src/db/schema/*.ts` (one file per area below), `src/db/migrations/` (generated), `src/db/seed.ts`
- Test: `tests/integration/db/schema.test.ts`

**Interfaces:**
- Produces: `db` (Drizzle client), `Tx` type (transaction handle), `withTx<T>(fn: (tx: Tx) => Promise<T>): Promise<T>`, and these tables (ids are UUIDv7 text, all tables have `createdAt`, `updatedAt`):

| File | Tables and key columns |
|---|---|
| `users.ts` | `users` (email unique, name, phone, role enum, rankId, badgeNumber, active, suspendedUntil, suspensionReason, mailingAddress nullable, lastSignInAt nullable, lockedAt nullable, lockReason nullable), `access_reviews` (startedAt, dueAt, completedAt nullable), `access_review_items` (reviewId, userId, decision enum `keep`/`change`/`deactivate` nullable, decidedBy, decidedAt, note), `ranks` (name, sortOrder unique, inLadder bool, active) |
| `auth.ts` | tables Better Auth requires (sessions, accounts, verifications, twoFactors) |
| `watches.ts` | `job_watches` (userId, jobId, createdAt, endedAt nullable) |
| `vendors.ts` | `vendors` (name, typeId, contactName, phone, billingEmails text[], defaultRateCents, minimumBillableMinutes nullable, active, paymentHold bool, paymentHoldReason, notes), `vendor_holds` (vendorId, placedBy, placedAt, reason, resolvedBy, resolvedAt, outcome enum `fix_coming`/`handled` nullable, note), `vendor_restrictions` (userId, vendorId, reason, createdBy, createdAt, liftedBy nullable, liftedAt nullable), `vendor_documents` (vendorId, kind enum `contract`/`other`, label, fileId nullable, url nullable, signedOn nullable, expiresOn nullable), `vendor_types`, `vendor_locations` (vendorId, name, address, lat, lng, geocodeSource enum `auto`/`manual`, notes), `vendor_users` (userId, vendorId) |
| `jobs.ts` | `job_types`, `job_series`, `jobs` (number serial unique, vendorId, locationId, typeId, seriesId, title, description, notes, startAt, endAt, rateCents, minimumBillableMinutes nullable, flexEarliestStartAt nullable, flexLatestEndAt nullable, flexAllowShorter bool, opsPlanRequired, opsPlanDueAt, contactName, contactPhone, state enum `requested`/`scheduled`/`active`/`canceled`/`declined`, canceledAt, canceledByVendor bool, lateCancelWaivedReason nullable, held bool, releaseAt, requestedByUserId, cancelReason), `job_safety` (jobId unique, notes, addedBy, addedAt, editedBy nullable, editedAt nullable), `job_safety_addresses` (jobId, address, description, lat, lng, addedBy, addedAt, editedBy nullable, editedAt nullable), `position_types` (name, eligibleRankIds text[], requiredQualificationIds text[], isIncidentCommander bool, vendorRequestable bool, active, sortOrder), `job_positions` (jobId, positionTypeId, count, eligibleRankIdsOverride text[] nullable, requiredQualificationIdsOverride text[] nullable), `qualifications` (name, active), `user_qualifications` (userId, qualificationId, grantedBy, grantedAt, revokedAt nullable), `qualification_requests` (userId, qualificationId, note, status enum `pending`/`approved`/`denied`, decidedBy, decidedAt, reason), `spot_offers` (jobPositionId, mode enum `sequential`/`all_backups`, offeredToAssignmentId nullable, endsAt, status enum `open`/`accepted`/`expired`) |
| `assignments.ts` | `assignments` (jobId, jobPositionId, userId, status enum `pending_short`/`signed_up`/`backup`/`canceled`/`removed`/`no_show`/`late_canceled`/`billed`/`paid`, requestedAt, backupPosition, warningVersion, warningAcceptedAt, plannedStartAt, plannedEndAt, actualStartAt, actualEndAt, hoursChangeReason, billedAt, overrideReason, isIncidentCommander bool), unique partial index on (jobId, userId) where status not in (`canceled`,`removed`) |
| `billing.ts` | `invoices` (number unique, assignmentId unique, vendorId, payeeUserId, minutes, rateCents, totalCents, status enum `pending_review`/`sent`/`returned`/`paid`/`written_off`, revision int, sentAt, attachW9 bool, emailStatus enum `queued`/`sent`/`failed`, kind enum `detail`/`late_cancel`, deputyPaidAt, deputyMethodId, deputyReference, vendorPaidAt, vendorPaidMethodId, vendorPaidReference, responsibleParty enum `deputy`/`coordinator`/`vendor` nullable, responsibleSince, closedReason), `invoice_events` (invoiceId, actorUserId nullable for system, event, party, note, at), `payment_methods` (name, active, sortOrder), `note_presets` (context enum `vendor_paid`/`deputy_paid`/`report_nonpayment`/`issue_note`/`waiting_on`/`send_back`, text, active, sortOrder), `payment_issues` (invoiceId, openedBy, note, status enum `open`/`paid`/`resolved`/`written_off`, waitingOn enum `coordinator`/`vendor`/`deputy`), `payment_issue_notes` |
| `files.ts` | `files` (storageKey, filename, contentType, size, encrypted bool, ownerUserId, kind enum `w9`/`contract`/`attachment`/`ops_plan`), `job_attachments` (jobId, label, fileId nullable, url nullable, isContract bool; exactly one of file or url), `w9s` (userId, fileId, uploadedAt, current bool) |
| `ops-plans.ts` | `ops_plans` (jobId, vendorId, eventName, year, location, status enum `due`/`submitted`/`agreed`/`denied`), `ops_plan_versions` (opsPlanId, fileId, submittedBy, submittedAt, decision, decidedBy, decidedAt, comments) |
| `seasons.ts` | `seasons` (name, startMonthDay `MM-DD`, endMonthDay `MM-DD`, rollingCapMinutes nullable, weekCapMinutes nullable, monthCapMinutes nullable; null means not enforced) |
| `notifications.ts` | `notifications` (userId, type, title, body, link, readAt), `notification_prefs` (userId, type, email bool, push bool), `quiet_hours`, `push_subscriptions`, `messages`, `message_recipients` |
| `settings.ts` | `settings` (single row, `value jsonb`) |
| `audit.ts` | `audit_log` (actorUserId, action, entityType, entityId, before jsonb, after jsonb, reason, at) |

- [ ] **Step 1:** Write `schema.test.ts`: migrations apply to an empty database; inserting a second active assignment for the same (jobId, userId) throws; inserting one after the first is `canceled` succeeds.
- [ ] **Step 2:** Run it. Expected: FAIL.
- [ ] **Step 3:** Write the schema files, generate migrations with drizzle-kit, write `seed.ts` (default ranks in order with `inLadder` true, plus `Dispatcher` with `inLadder` false; position types `Posse` (Posse, CSO, Deputy Sheriff), `CSO` (CSO, Deputy Sheriff), `Deputy Sheriff` (Deputy Sheriff), `Incident Commander` (Posse, CSO, Deputy Sheriff, requires the `Incident Commander` qualification; `isIncidentCommander`), `Dispatcher` (Dispatcher), `School Resource Deputy` (Deputy Sheriff, requires `School Resource Deputy`; vendor requestable); `Deputy Sheriff`, `CSO`, `Posse`, `Incident Commander` and `Dispatcher` vendor requestable; qualifications `Incident Commander`, `School Resource Deputy`, `K9`, `Motors`; one admin from `SEED_ADMIN_EMAIL`, job types `Basic Security`, `Traffic Control`, `County Permitted Event`, payment methods `Check handed to deputy`, `Check mailed`, `Cash`, `Ramp`, `Bill.com`, `Other`, and one season `All year` `01-01`..`12-31` with rollingCapMinutes 960 and null week and month caps).
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5:** Commit: `Add database schema and migrations`

### Task 4: Settings

**Files:**
- Create: `src/domain/settings/settings.ts`, `src/domain/settings/defaults.ts`
- Test: `tests/integration/settings/settings.test.ts`

**Interfaces:**
- Consumes: `Tx`, `recordAudit` (Task 5).
- Produces: `AgencySettings` (Zod schema and type), `getSettings(tx: Tx): Promise<AgencySettings>`, `updateSettings(actor: Actor, tx: Tx, patch: Partial<AgencySettings>): Promise<AgencySettings>`.

Defaults (exact values, in `defaults.ts`):

| Key | Default | Spec source |
|---|---|---|
| `releaseDayOfMonth` | 15 | 9, release |
| `releaseTime` | `'16:00'` | 9, release |
| `weekStartsOn` | 0 (Sunday) | 10.3 |
| `rollingCapWindowHours` | 24 | 10.3 |
| `signupWarningText`, `signupWarningVersion` | `''`, 1 | 10.1 |
| `defaultPositionTypeId` | id of `Deputy Sheriff` position type | 6, positions |
| `shortShiftWindowHours` | 24 | 9, flexible times |
| `backupOfferMode` | `'sequential'` (`'sequential'`, `'all_backups'`, `'everyone'`) | 10.4 |
| `backupWindowMinutes` | 30 | 10.4 |
| `backupFirstComeHours` | 12 | 10.4 |
| `minimumBillableMinutes` | 240 (4 hours) | 12.2a |
| `lateVendorCancelHours` | 24 | 12.9 |
| `lateCancelPayBasis` | `'minimum'` (`'minimum'` or `'scheduled'`) | 12.9 |
| `hourRoundingMinutes` | 15 | 18 |
| `agencyDefaultRateCents` | 0 (jobs refuse rate 0) | 9 |
| `invoiceReviewMode` | `'changed_hours_only'` (`'immediate'`, `'changed_hours_only'`, `'all'`) | 12.3 |
| `invoiceNumberPrefix` | `'ED-'` | 12.2 |
| `billingReplyToEmail` | `''` (required before invoices send) | 12.2 |
| `email` | `{ provider: 'smtp' | 'postmark' | 'ses' | 'sendgrid' | 'mailgun'; from: ''; smtp: { host: '', port: 587, secure: false, user: '', passwordEnc: '' }; apiKeyEnc: ''; region: '' }` (provider `smtp` by default until one is chosen) | 12.2 |
| `unbilledReminderFrequency` | `'daily'` (`'daily'`, `'every_other_day'`, `'weekly'`) | 10.6 |
| `unbilledGraceHours` | 24 | 10.6 |
| `billingLockEnabled` | true | 10.6 |
| `responseDays` | `{ vendor: 30, deputy: 30, coordinator: 7 }` | 12.10 |
| `paymentAckLockMode` | `'vendor_reported'` (`'off'`, `'vendor_reported'`, `'all_invoices'`) | 10.7 |
| `vendorReminderEnabled` | false | 12.10 |
| `inactivityLockDays` | 90 | 7 |
| `accessReviewMonthDay`, `accessReviewEveryMonths` | `'01-15'`, 12 | 7 |
| `opsPlanReviewerUserIds` | `[]` | 11 |
| `opsPlanDefaultDueHours` | 72 | 11 |
| `capHoursMode` | `'details_only'` (`'details_only'` or `'details_plus_schedule'`) | 10.3 |
| `vendorMinNoticeHours` | 72 | 8 |
| `vendorEditLockHours` | 24 | 8 |
| `vendorEditsAfterSignup` | `'none'` (`'none'`, `'add_positions'`) | 8 |
| `vendorCancelUntilHours` | 24 | 8 |
| `vendorCanSetRate` | false | 8 |
| `vendorSeesAssignedNames` | true | 8 |
| `personnelCanMessageAll` | true | 14 |
| `mapTileUrl`, `mapAttribution` | hosted OpenStreetMap tile provider URL and its attribution text | 10.8 |
| `agency` | `{ name: 'Your Agency', sheriffName: '', address: '', phone: '', email: '', website: '', logoFileId: null }` (logo PNG or SVG via `uploadFile`, shown on invoices, report PDFs, sign-in page and app header) | 12.2 |

Add security settings: `security: { twoFactorRequired: true; emailCodeMinutes: 15; emailCodeAttempts: 5; trustedDeviceDays: 30; passwordMinLength: 12 }`. Admin-only keys (`ADMIN_SETTING_KEYS`): `email`, `security`. Every other key can be changed by coordinators and admins.

- [ ] **Step 1:** Tests: `getSettings` on a fresh DB returns the defaults above; a coordinator can update `minimumBillableMinutes` but `updateSettings({ email })` by a coordinator throws `ForbiddenError`; personnel cannot update anything; an update persists and writes one audit row with before and after; `releaseDayOfMonth: 0` and `32` are rejected by Zod; changing `signupWarningText` increments `signupWarningVersion`.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement. Also create `src/lib/crypto/secrets.ts` with `encryptSecret(plain: string): string` and `decryptSecret(enc: string): string` (AES-256-GCM, key from env `SECRETS_KEY`, base64 32 bytes); the SMTP password is stored only as `passwordEnc`.
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5:** Commit: `Add agency settings with defaults`

### Task 5: Errors, actor and audit log

**Files:**
- Create: `src/domain/errors.ts`, `src/domain/actor.ts`, `src/domain/audit/audit.ts`
- Test: `tests/integration/audit/audit.test.ts`

**Interfaces:**
- Produces:
  - `type Role = 'admin' | 'coordinator' | 'personnel' | 'vendor'`
  - `type Actor = { userId: string; role: Role; rankId: string | null; vendorId: string | null }`
  - `class DomainError extends Error { code: string }`, `ForbiddenError`, `NotFoundError`, `RuleViolation` (has `checks: CheckResult[]`), `ValidationError`
  - `recordAudit(tx: Tx, e: { actor: Actor | 'system'; action: string; entityType: string; entityId: string; before?: unknown; after?: unknown; reason?: string }): Promise<void>`
  - `listAudit(actor: Actor, tx: Tx, filter: { entityType?: string; entityId?: string; from?: Date; to?: Date }, page: number): Promise<AuditRow[]>` (coordinator and admin)

- [ ] **Step 1:** Tests: `recordAudit` stores the row; `listAudit` as personnel throws `ForbiddenError` and as coordinator succeeds; filter by entity returns only matching rows, newest first.
- [ ] **Step 2–4:** Run (FAIL), implement, run (PASS).
- [ ] **Step 5:** Commit: `Add domain errors, actor and audit log`

### Task 6: Authentication

**Files:**
- Create: `src/lib/auth.ts` (Better Auth config), `src/app/api/auth/[...all]/route.ts`, `src/domain/auth/session.ts`, `src/domain/auth/invites.ts`, `src/app/(auth)/sign-in/page.tsx` (shows, beside the "Forgot password?" link, "Accounts not signed in within the past 3 months require a password reset." with the period taken from `inactivityLockDays`), `src/app/(auth)/two-factor/page.tsx`, `src/app/(auth)/accept-invite/page.tsx`
- Test: `tests/integration/auth/auth.test.ts`

**Interfaces:**
- Consumes: `users`, auth tables, `sendEmail` stub interface `EmailSender` (Task 23 provides the real one; here inject `EmailSender = { send(msg: OutgoingEmail): Promise<void> }` and use an in-memory sender in tests).
- Produces: `getActor(headers: Headers): Promise<Actor | null>`, `requireActor(headers: Headers): Promise<Actor>` (throws `UnauthenticatedError`), `createInvite(actor: Actor, tx: Tx, userId: string): Promise<void>`, `acceptInvite(token: string, password: string): Promise<void>`.

- [ ] **Step 1:** Tests: invite token expires after 7 days; accepting sets the password; after a correct password the user must enter a 6-digit code sent by email, and `getActor` returns null until they do; a correct code returns the user's role and rank; a code older than 15 minutes or a sixth wrong attempt is refused and a new code is needed; on staging the code is shown on the screen and no email is sent; there is no authenticator-app option anywhere; a deactivated user cannot sign in; the sign-in page shows the 3-month notice next to "Forgot password?" and it reads "6 months" when `inactivityLockDays` is 180; a locked (inactive) user who enters the right password is sent to self-service unlock, receives a reset link and a 6-digit code by email, sets a new password, and is unlocked with `lastSignInAt` updated, without coordinator action; the sixth failed sign-in within 15 minutes for one email returns 429.
- [ ] **Step 2–4:** Run (FAIL), configure Better Auth (email and password, `twoFactor` plugin with email OTP only, required for every account, trusted device 30 days, rate limit), run (PASS).
- [ ] **Step 5:** Commit: `Add sign-in with required two-factor and invites`

### Task 7: Authorization policy

**Files:**
- Create: `src/domain/auth/policy.ts`
- Test: `tests/unit/auth/policy.test.ts`

**Interfaces:**
- Produces: `type Action` (string union, one per service operation, for example `'job.create'`, `'job.signup'`, `'invoice.review'`, `'w9.read'`, `'user.suspend'`, `'settings.update'`), `can(actor: Actor, action: Action, ctx?: { ownerUserId?: string; vendorId?: string }): boolean`, `assertCan(...)` (throws `ForbiddenError`).

- [ ] **Step 1:** Table-driven test over every `Action` and each role. Required rows include: `user.suspend`, `user.manage`, `rank.manage`, `lateCancel.waive`, `audit.read`, `vendor.paymentHold`, `vendorRestriction.manage`, `settings.update.rules` and `season.manage` coordinator and admin, not personnel; `settings.update.system` (SMTP and security) admin only; `w9.read` owner, coordinator, admin (not other personnel, not vendor); `job.read` for vendor only when `ctx.vendorId === actor.vendorId`; `invoice.vendorMarkPaid` vendor of that invoice only; `opsPlan.review` handled in Task 32, not here.
- [ ] **Step 2–4:** Run (FAIL), implement, run (PASS).
- [ ] **Step 5:** Commit: `Add role permission policy`

### Task 8: Ranks

**Files:**
- Create: `src/domain/ranks/ranks.ts`, `src/app/api/v1/ranks/route.ts`
- Test: `tests/unit/ranks/rank-order.test.ts`, `tests/integration/ranks/ranks.test.ts`

**Interfaces:**
- Produces: `ranksAtOrAbove(rankId: string, ranks: Rank[]): string[]` (ladder ranks only; the "X and higher" shortcut), `isEligible(rankId: string, eligibleRankIds: string[]): boolean`, `listRanks(tx)`, `createRank(actor, tx, { name, sortOrder })`, `reorderRanks(actor, tx, orderedIds: string[])`, `deactivateRank(actor, tx, id)`.

- [ ] **Step 1:** Tests: with seeded ranks, `ranksAtOrAbove(CSO)` is CSO and Deputy Sheriff (not Posse, not Dispatcher); `ranksAtOrAbove(Posse)` includes CSO; a Deputy Sheriff is eligible for a CSO position and a Posse is not eligible for a CSO position; reordering rewrites `sortOrder` 1..n; deactivating a rank that users still hold throws `RuleViolation`.
- [ ] **Step 2–4:** Run, implement, run.
- [ ] **Step 5:** Commit: `Add ranks`

### Task 9: Users and suspension

**Files:**
- Create: `src/domain/users/users.ts`, `src/domain/users/suspension.ts`, `src/app/api/v1/users/**/route.ts`
- Test: `tests/integration/users/users.test.ts`, `tests/integration/users/suspension.test.ts`

**Interfaces:**
- Consumes: `createInvite`, `recordAudit`, `assertCan`.
- Produces: `createUser(actor, tx, input: { email; name; phone; role; rankId; badgeNumber; qualificationIds?: string[] }): Promise<User>` (sends invite; grants the given qualifications with the creator as `grantedBy`), `updateUser`, `deactivateUser(actor, tx, id)`, `suspendUser(actor, tx, id, { reason: string; until: Date | null; removeFutureAssignments: boolean })`, `liftSuspension(actor | 'system', tx, id)`, `isSuspended(user, now): boolean`, `liftExpiredSuspensions(tx, now): Promise<number>` (worker job), worker `inactivityLockTick(now)` (locks accounts whose `lastSignInAt`, or invite acceptance when never signed in, is older than `inactivityLockDays`; audited as `system`), `startAccessReview(tx, now)` (worker on `accessReviewMonthDay`; one item per active account), `decideAccessReviewItem(actor, tx, itemId, { decision; note? })` (coordinators and admins; `deactivate` calls `deactivateUser`), daily reminders to coordinators until every item is decided, `accessReviewReport(actor, tx, reviewId)`.

- [ ] **Step 1:** Tests: personnel `suspendUser` throws `ForbiddenError`; coordinator suspend with `removeFutureAssignments: true` sets that user's future `signed_up` and `backup` assignments to `removed` with the suspension reason and leaves past ones; `isSuspended` is false once `until` has passed; an account last signed in 91 days ago is locked by `inactivityLockTick` and one at 89 days is not; the access review created on Jan 15 has one item per active account (vendor logins included), stays on the to-do list until every item is decided, and deciding `deactivate` deactivates the account; `liftExpiredSuspensions` clears it and audits as `system`; `deactivateUser` keeps the row and history.
- [ ] **Step 2–4:** Run, implement, run.
- [ ] **Step 5:** Commit: `Add user management and suspensions`

### Task 10: File storage and W-9 encryption

**Files:**
- Create: `src/lib/storage/storage.ts` (interface), `src/lib/storage/s3.ts`, `src/lib/storage/local.ts`, `src/lib/crypto/envelope.ts`, `src/domain/files/files.ts`, `src/domain/w9/w9.ts`
- Test: `tests/unit/crypto/envelope.test.ts`, `tests/integration/w9/w9.test.ts`

**Interfaces:**
- Produces:
  - `interface Storage { put(key: string, body: Buffer, contentType: string): Promise<void>; get(key: string): Promise<Buffer>; }`
  - `encryptFile(plain: Buffer, masterKey: Buffer): Buffer`, `decryptFile(blob: Buffer, masterKey: Buffer): Buffer` (per-file data key, AES-256-GCM, data key wrapped by master key; key from env `FILE_MASTER_KEY`, base64 32 bytes)
  - `uploadFile(actor, tx, input: { kind; filename; contentType; body: Buffer; ownerUserId? }): Promise<FileRow>` (max 20 MB; PDF, DOCX, JPG, PNG only)
  - `uploadW9(actor, tx, body: Buffer, filename: string): Promise<W9Row>` (PDF only; marks previous W-9 not current)
  - `readW9(actor, tx, userId): Promise<{ filename: string; body: Buffer; uploadedAt: Date }>` (policy `w9.read`; audit action `w9.read`)
  - `currentW9(tx, userId): Promise<W9Row | null>`

- [ ] **Step 1:** Tests: encrypt then decrypt round-trips; a flipped byte makes decrypt throw; another personnel user calling `readW9` throws `ForbiddenError`; a coordinator read succeeds and writes an audit row; the stored object bytes are not equal to the uploaded bytes; a `.exe` upload is rejected.
- [ ] **Step 2–4:** Run, implement, run.
- [ ] **Step 5:** Commit: `Add encrypted file storage and W-9 handling`

### Task 11: Vendors and vendor types

**Files:**
- Create: `src/domain/vendors/vendors.ts`, `src/app/api/v1/vendors/**/route.ts`
- Test: `tests/integration/vendors/vendors.test.ts`

**Interfaces:**
- Produces: `createVendor(actor, tx, input: { name; typeId; contactName; phone; billingEmails: string[]; defaultRateCents: Cents | null; notes })`, `updateVendor`, `setVendorActive`, `placePaymentHold(actor, tx, vendorId, reason: string)` and `resolvePaymentHold(actor, tx, vendorId, { outcome: 'fix_coming' | 'handled'; note?: string })` (coordinator and admin; placing alerts everyone signed up for that vendor's future details; resolving alerts the people signed up for that vendor's future details), `addLocation` (coordinators, admins, and vendor users for their own vendor; geocodes the address with `geocodeAddress`), `setLocationActive` (deactivate instead of delete when used by any job), `updateLocation`, `setLocationPin(actor, tx, locationId, { lat; lng })` (manual correction), `geocodeAddress(address: string): Promise<{ lat: number; lng: number } | null>` (OpenStreetMap Nominatim, at most 1 request per second, generic User-Agent, results cached; failure leaves the pin empty and does not block saving), `addVendorDocument(actor, tx, vendorId, { kind; label; file?: Buffer; url?: string; signedOn?: Date; expiresOn?: Date })` (exactly one of file or https url), `listVendorDocuments(actor, tx, vendorId)` (coordinators, admins, that vendor), worker `contractExpiryTick(now)` (alert coordinators 60 and 30 days before `expiresOn`, once each), `createVendorLogin(actor, tx, vendorId, { email; name })` (creates `vendor` role user plus `vendor_users` row and invite), `listVendors(actor, tx, filter)`.

- [ ] **Step 1:** Tests: personnel `createVendor` throws `ForbiddenError`; billing emails are validated; `createVendorLogin` produces a user whose actor has `vendorId` set; a vendor actor listing vendors sees only their own; adding a location stores the geocoded pin (Nominatim mocked) and a geocoder failure still saves the location; a vendor user can add and edit their own locations and gets `NotFoundError` for another vendor's; a location used by a job cannot be deleted, only deactivated, and deactivated locations are not offered for new details; `placePaymentHold` by personnel throws; a vendor created with no contract is saved and can have jobs created at once; `jobContractStatus(tx, jobId)` returns `vendor` when the vendor has a current (not expired) contract, `detail` when the job has an attachment marked `isContract`, else `missing`; `detailsMissingContract(tx)` lists upcoming and recent jobs with `missing`; deputies never see contract attachments; a vendor document with both file and url is rejected; personnel cannot list vendor documents; a contract expiring in 60 days alerts coordinators once, and again at 30 days.
- [ ] **Step 2–4:** Run, implement, run.
- [ ] **Step 5:** Commit: `Add vendors, locations, contracts and vendor logins`

### Task 12: Job types and seasons admin

**Files:**
- Create: `src/domain/jobs/job-types.ts`, `src/domain/caps/seasons.ts`
- Test: `tests/integration/caps/seasons.test.ts`

**Interfaces:**
- Produces: job type CRUD, qualification CRUD and `grantQualification(actor, tx, userId, qualificationId)` / `revokeQualification` (coordinators and admins; audited), `requestQualification(actor, tx, qualificationId, note?)` (personnel, own account; alerts coordinators), `decideQualificationRequest(actor, tx, requestId, { approve: boolean; reason?: string })` (coordinators and admins; approval grants the flag; alerts the requester), position type CRUD (name, eligible ranks, required qualifications, Incident Commander flag), payment method CRUD and note preset CRUD per context (coordinator and admin; seed two or three presets per context); `createSeason(actor, tx, input: { name; startMonthDay; endMonthDay; rollingCapMinutes; weekCapMinutes; monthCapMinutes })`, `updateSeason`, `deleteSeason` (seasons are config, deletion allowed), `seasonFor(date: Date, seasons: Season[]): Season | null`.

- [ ] **Step 1:** Tests: `seasonFor` returns `Summer` (`05-01`..`09-30`) for July 4 and `Off season` (`10-01`..`04-30`, wraps the year end) for Jan 15; overlapping seasons are rejected on create; a deputy's flag request appears for coordinators, approval grants the flag and alerts the deputy, denial with a reason alerts them and grants nothing; a deputy cannot grant themselves a flag or see another person's flags; `createUser` with two qualification ids grants both, audited with the creator; a date covered by no season returns null (meaning no caps).
- [ ] **Step 2–4:** Run, implement, run.
- [ ] **Step 5:** Commit: `Add job types and cap seasons`

### Task 13: Jobs

**Files:**
- Create: `src/domain/jobs/jobs.ts`, `src/domain/jobs/rate.ts`, `src/app/api/v1/jobs/**/route.ts`
- Test: `tests/unit/jobs/rate.test.ts`, `tests/integration/jobs/jobs.test.ts`

**Interfaces:**
- Consumes: `releaseAt` (Task 14), settings, vendors.
- Produces:
  - `resolveRate(jobRate: Cents | null, vendorDefault: Cents | null, agencyDefault: Cents): Cents`
  - `type JobInput = { vendorId; locationId; typeId; title; description; notes; startAt: Date; endAt: Date; rateCents: Cents | null; positions: Array<{ positionTypeId: string; count: number; eligibleRankIdsOverride?: string[] }>; opsPlanRequired: boolean; opsPlanDueAt: Date | null; contactName; contactPhone; held: boolean; flex?: { earliestStartAt: Date; latestEndAt: Date; allowShorter: boolean }; safety?: { notes: string; addresses: Array<{ address: string; description: string }> } }` (safety addresses are geocoded with `geocodeAddress`; a failed lookup keeps the address without a pin)
  - `createJob(actor, tx, input: JobInput): Promise<Job>` (state `scheduled`, computes `releaseAt`)
  - `updateJob(actor, tx, id, patch: Partial<JobInput>, scope: 'one' | 'series'): Promise<Job[]>`
  - `cancelJob(actor, tx, id, reason: string)`, `releaseHold(actor, tx, id)`, `getJob(actor, tx, id)`
  - `listJobs(actor, tx, filter: { from; to; status?: JobDisplayStatus[]; typeIds?; vendorIds?; text?; mine?: boolean }, page)`

- [ ] **Step 1:** Tests: `resolveRate(null, 7000, 6500) === 7000`; `resolveRate(null, null, 6500) === 6500`; `createJob` with resolved rate 0 throws `ValidationError`; `endAt <= startAt` throws; a job with no positions given gets one position of `defaultPositionTypeId` and the count must be at least 1; 1 Dispatcher + 1 Incident Commander + 14 Deputy Sheriff + 1 CSO stores four positions and a personnel total of 17; an override of eligible ranks on one position is stored and used; `flex` with `earliestStartAt` after `startAt` or `latestEndAt` before `endAt` throws `ValidationError`; `safety` with two addresses stores both with pins and each records who added it and when; editing a note records the editor and time and keeps the earlier text in the audit history; `getJob` returns `addedByName`, `addedByRole` (vendor, coordinator or admin), `addedAt`, and edit details for the note and each address; changing safety notes on a job with sign-ups writes audit and emits `job.safety_changed`; `getJob` for a vendor actor returns safety only for their own job; `opsPlanRequired` with null due date stores start minus `opsPlanDefaultDueHours`; `opsPlanRequired: true` with no IC position is allowed (the IC is then named from the roster, Task 32); rate change on a job with signed-up people writes audit and emits `job.rate_changed` (assert on the outbox from Task 26 once it exists; here assert the audit row).
- [ ] **Step 2–4:** Run, implement, run.
- [ ] **Step 5:** Commit: `Add jobs with rate resolution and IC settings`

### Task 14: Release rules

**Files:**
- Create: `src/domain/release/release.ts`
- Test: `tests/unit/release/release.test.ts`, `tests/integration/release/recompute.test.ts`

**Interfaces:**
- Produces:
  - `releaseAt(detailStart: Date, s: { releaseDayOfMonth: number; releaseTime: string }): Date`: the release instant for the detail's month is `releaseDayOfMonth` at `releaseTime` (agency time) of the previous month, clamped to that month's last day.
  - `isReleased(job: { held: boolean; releaseAt: Date; state: JobState }, now: Date): boolean`
  - `recomputeReleaseDates(tx, settings)` (runs when release settings change; only jobs not yet released)
  - No alerts are sent at release or when a job is posted (spec 9).

- [ ] **Step 1: Write failing tests**

```ts
const s = { releaseDayOfMonth: 15, releaseTime: '16:00' };
it('December details release Nov 15 at 4 PM Central', () => {
  expect(releaseAt(agencyInstant(2026, 12, 5, 8, 0), s)).toEqual(agencyInstant(2026, 11, 15, 16, 0));
});
it('a detail later this month is already released', () => {
  const job = { held: false, state: 'active', releaseAt: releaseAt(agencyInstant(2026, 11, 28, 8, 0), s) };
  expect(isReleased(job, agencyInstant(2026, 11, 22, 9, 0))).toBe(true);
});
it('clamps day 31 to the last day of a 30-day month', () => {
  expect(releaseAt(agencyInstant(2026, 12, 1, 8, 0), { ...s, releaseDayOfMonth: 31 })).toEqual(agencyInstant(2026, 11, 30, 16, 0));
});
it('clamps into February', () => {
  expect(releaseAt(agencyInstant(2027, 3, 10, 8, 0), { ...s, releaseDayOfMonth: 30 })).toEqual(agencyInstant(2027, 2, 28, 16, 0));
});
it('held jobs are never released', () => {
  expect(isReleased({ held: true, state: 'active', releaseAt: new Date(0) }, new Date())).toBe(false);
});
```

- [ ] **Step 2–4:** Run (FAIL), implement, run (PASS). Integration test: changing `releaseDayOfMonth` to 20 moves `releaseAt` for unreleased jobs only, and no notification rows are created at release.
- [ ] **Step 5:** Commit: `Add monthly release rules and release alerts`

### Task 15: Copy, recurrence and series edits

**Files:**
- Create: `src/domain/jobs/recurrence.ts`, `src/domain/jobs/copy.ts`
- Test: `tests/unit/jobs/recurrence.test.ts`, `tests/integration/jobs/copy.test.ts`

**Interfaces:**
- Produces:
  - `type Recurrence = { kind: 'daily'; every: number } | { kind: 'weekly'; every: number; weekdays: number[] } | { kind: 'monthly'; every: number; dayOfMonth: number }` with `end: { count: number } | { until: Date }` (max 366 occurrences)
  - `expandRecurrence(first: { startAt: Date; endAt: Date }, r: Recurrence): Array<{ startAt: Date; endAt: Date }>` (keeps agency wall-clock times across DST)
  - `type DateSelection = { kind: 'range'; from: string; to: string; weekdays?: number[] } | { kind: 'dates'; dates: string[] } | { kind: 'pattern'; recurrence: Recurrence }` (dates are agency `YYYY-MM-DD` keys)
  - `expandDates(selection: DateSelection, firstDate: string): string[]` (sorted, de-duplicated, max 366; a range is inclusive; weekdays filter optional)
  - `previewBulk(input: JobInput, dates: string[], overrides?: Record<string, { startTime?: string; endTime?: string }>): Array<{ date; startAt; endAt; releaseAt }>` (applies the input's wall-clock start and end times to each date in agency time, crossing midnight when end is earlier than start; per-date overrides)
  - `createJobsOnDates(actor, tx, input: JobInput, dates: string[], overrides?): Promise<Job[]>` (one transaction; every job shares a new `seriesId` and copies positions, flex, safety and attachments; audited once per job plus one `series.created` entry)
  - `copyJob(actor, tx, sourceId, selection: DateSelection, opts: { copyAssignments: boolean; copyAttachments: boolean }): Promise<Job[]>` (copies an existing job onto the selected dates through `createJobsOnDates`)
  - `createRecurringJobs(actor, tx, sourceId, r: Recurrence): Promise<Job[]>` (shares a `seriesId`)

- [ ] **Step 1:** Tests: weekly Sundays 7:30 to 12:00 from Oct 25, 2026 for 3 occurrences gives Oct 25, Nov 1, Nov 8, each 7:30 local (Nov 1 is a DST day); `until` is inclusive of that date; a range Dec 15 to Dec 31 gives 17 dates and with weekdays [0,6] gives only the weekend dates; specific dates `2026-12-01, 12-12, 12-19, 12-20, 12-21, 12-30` plus a duplicate give 6 sorted dates; 367 dates throws `ValidationError`; `previewBulk` for 8:00 PM to 6:00 AM on Mar 13, 2027 ends 6:00 AM Mar 14 (a DST day) and lasts 9 hours; a per-date override changes only that date; `createJobsOnDates` for 6 dates creates 6 jobs with one shared seriesId and identical positions, rolls back entirely if one date fails validation; copying with assignments re-runs overlap checks and marks conflicts instead of failing the whole copy (returns `conflicts: Array<{ jobId; userId }>`).
- [ ] **Step 2–4:** Run, implement, run.
- [ ] **Step 5:** Commit: `Add job copy, recurrence and series edits`

### Task 16: Hour caps

**Files:**
- Create: `src/domain/caps/caps.ts`
- Test: `tests/unit/caps/caps.test.ts`

**Interfaces:**
- Consumes: `agencyWeekKey`, `agencyMonthKey`, `seasonFor`.
- Produces: `evaluateCaps(input: { existing: Array<{ startAt: Date; endAt: Date }>; candidate: { startAt: Date; endAt: Date }; seasons: Season[]; weekStartsOn: number; rollingWindowHours: number }): Array<{ cap: 'rolling' | 'week' | 'month'; period: string; usedMinutes: Minutes; limitMinutes: Minutes; ok: boolean }>`

Rules:
- Rolling cap: the largest number of worked minutes inside any window of `rollingWindowHours` that overlaps the candidate, counting the candidate. The maximum always occurs at a window that starts at some interval's start or ends at some interval's end, so check only those windows (intervals = existing plus candidate). Limit from the season of the candidate's start. `period` is the worst window as `start/end` ISO.
- Week and month caps: calendar periods in agency time; minutes split at period boundaries; each period's limit from the season of the period's first day.
- No season means no cap; that entry is omitted.

- [ ] **Step 1:** Tests (summer caps rolling 960, week 1920, month 6000): existing 6:00 AM to 12:00 PM plus candidate 2:00 PM to 10:00 PM the same day gives rolling `usedMinutes: 840, ok: true`; adding a candidate 8:00 PM to 6:00 AM after an existing 6:00 AM to 12:00 PM the same day gives 960 in the window 6:00 AM to 6:00 AM, `ok: true`, and one more minute fails; existing 8:00 PM to 6:00 AM then candidate 10:00 AM to 4:00 PM the next day counts both (16 h within 24 h), `ok: true` at 960 and `false` with rolling limit 900; a detail ending 24 h before the candidate starts does not count; a week spanning two months counts both months separately.
- [ ] **Step 2–4:** Run, implement, run.
- [ ] **Step 5:** Commit: `Add seasonal hour cap evaluation`

### Task 17: Eligibility engine

**Files:**
- Create: `src/domain/eligibility/eligibility.ts`
- Test: `tests/unit/eligibility/eligibility.test.ts`

**Interfaces:**
- Produces:
  - `type CheckResult = { check: 'state' | 'vendor_hold' | 'vendor_restricted' | 'rank' | 'qualification' | 'active' | 'suspended' | 'billing_lock' | 'overlap' | 'cap_rolling' | 'cap_week' | 'cap_month' | 'already_on_job'; ok: boolean; message: string }`
  - `evaluateSignup(ctx: { now: Date; job: JobForRules; position: { name: string; eligibleRankIds: string[]; eligibleRankNames: string[]; requiredQualificationIds: string[]; requiredQualificationNames: string[]; free: number }; person: { active: boolean; suspendedUntil: Date | null; rankId: string; qualificationIds: string[] }; personAssignments: Array<{ jobId: string; startAt: Date; endAt: Date; status: AssignmentStatus }>; billingLock: { locked: boolean; unbilledCount: number; unacknowledgedCount: number }; caps: ReturnType<typeof evaluateCaps> }): { canSignUp: boolean; canBackup: boolean; checks: CheckResult[] }`

Messages are user-facing and exact, for example `"Bill 2 past details to sign up again"`, `"Requires the Incident Commander flag"`, `"Overlaps job #68689"`, `"Month cap: 92 of 100 hours with this detail"`, `"24-hour cap: 18 of 16 hours in any 24 hours with this detail"` (window length from settings).

- [ ] **Step 1:** Tests: every check fails independently with its exact message; a full job with all other checks passing returns `canSignUp: false, canBackup: true`; a person already on the job returns both false; a CSO signing up for a Deputy Sheriff position fails `rank`; a Dispatcher is eligible only for the Dispatcher position; a Deputy Sheriff without the School Resource Deputy flag fails `qualification` with "Requires the School Resource Deputy flag" on an SRO position and passes once granted; a Deputy Sheriff without the Incident Commander flag cannot take an IC position and a flagged one can; a full position with free spots in another position returns `canSignUp: false` for the full one only; a job not released (`state` check) blocks both.
- [ ] **Step 2–4:** Run, implement, run.
- [ ] **Step 5:** Commit: `Add sign-up eligibility engine`

### Task 18: Sign-up and job status

**Files:**
- Create: `src/domain/assignments/signup.ts`, `src/domain/jobs/status.ts`, `src/app/api/v1/jobs/[id]/signup/route.ts`
- Test: `tests/unit/jobs/status.test.ts`, `tests/integration/assignments/signup.test.ts`

**Interfaces:**
- Consumes: `evaluateSignup`, `evaluateCaps`, settings.
- Produces:
  - `type BillingLockReader = (tx: Tx, userId: string, now: Date) => Promise<{ locked: boolean; unbilledCount: number; unacknowledgedCount: number }>`; this task ships `noBillingLock` (always unlocked) and Task 30 replaces it with the real reader
  - `type JobDisplayStatus = 'requested' | 'scheduled' | 'open' | 'filled' | 'ready_to_bill' | 'billed' | 'closed' | 'expired' | 'canceled' | 'declined' | 'on_hold'` (`on_hold` when the vendor is on payment hold and the job has not started)
  - `deriveJobStatus(job, assignments, invoices, now): JobDisplayStatus`
  - `validatePlannedTimes(job, planned: { startAt: Date; endAt: Date }): void` (without `flex`, planned must equal the job times; with `flex`, planned must sit inside `[flexEarliestStartAt, flexLatestEndAt]`, be on 15-minute boundaries, and equal the default length; it may be shorter (never longer) only when `flexAllowShorter`; signature `validatePlannedTimes(job, planned): { shorter: boolean }`)
  - `signUp(actor, tx, jobPositionId, input: { warningVersion: number; plannedStartAt?: Date; plannedEndAt?: Date }): Promise<Assignment>` (planned times default to the job times; eligibility checks for overlaps and caps use the planned interval; a shorter sign-up made before `startAt - shortShiftWindowHours` is stored as `pending_short`, holds no spot and is not counted in staffing; inside the window it is `signed_up` at once if a spot is free)
  - `confirmPendingShortTick(now)` (worker, every minute): for jobs whose window just opened, confirms `pending_short` sign-ups in `requestedAt` order while their position has free spots, re-running overlap and cap checks; the rest become `canceled` with reason `"Filled by full-length sign-ups"` or the failed check; each person gets `signup.short_confirmed` or `signup.short_declined`
  - `changePlannedTimes(actor, tx, assignmentId, { startAt: Date; endAt: Date })` (own assignment, before the job's earliest start; re-runs `validatePlannedTimes`, overlap and cap checks; the vendor sees the new times)
  - `watchJob(actor, tx, jobId)` and `unwatchJob(actor, tx, jobId)` (personnel; allowed on full or not-yet-released jobs; holds no place; ends after its first alert, when the watcher signs up, or at the job's start)
  - `joinBackup(actor, tx, jobPositionId, input: { warningVersion: number })` (backups are per position): Promise<Assignment>`
  - `eligibilityFor(actor, tx, jobId): Promise<{ canSignUp; canBackup; checks: CheckResult[]; backupPosition: number }>`

Concurrency: `signUp` locks the job row (`select ... for update`), recounts active `signed_up` assignments for that position, then inserts.

- [ ] **Step 1:** Tests: `deriveJobStatus` returns `open` when released with free spots, `filled` when full, `ready_to_bill` after `endAt`, `billed` when every signed-up person has an invoice, `closed` when all invoices are `paid` or `written_off`, `expired` when `startAt` passed with free spots; `signUp` with a stale `warningVersion` throws `RuleViolation`; **two concurrent `signUp` calls for the last spot (Promise.all on separate connections) produce exactly one assignment and one `RuleViolation` whose checks say the job is full**; `joinBackup` assigns positions 1, 2, 3 in order; on a 5:00 PM to 11:00 PM job with flex 5:00 PM to 12:00 AM, planned 5:45 PM to 11:45 PM is accepted, 9:00 PM to 3:00 AM is refused, with `flexAllowShorter`, 6:00 PM to 11:00 PM requested 3 days before the start is `pending_short` and does not reduce open spots; a full-length sign-up the next day takes the last spot; when the window opens the pending one is declined with "Filled by full-length sign-ups"; with a spot still free it is confirmed instead, and two pending requests confirm in request order; a shorter sign-up 20 hours before the start with a free spot is `signed_up` immediately; a planned 5:45 PM start that overlaps another detail ending 5:30 PM is accepted while 5:15 PM is refused.
- [ ] **Step 2–4:** Run, implement, run.
- [ ] **Step 5:** Commit: `Add first come first served sign-up and job status`

### Task 19: Cancellation, backups, coordinator actions

**Files:**
- Create: `src/domain/assignments/cancel.ts`, `src/domain/assignments/backups.ts`, `src/domain/assignments/coordinator.ts`, `src/jobs/backup-window.ts`
- Test: `tests/integration/assignments/cancel.test.ts`, `tests/integration/assignments/coordinator.test.ts`

**Interfaces:**
- Produces:
  - `cancelSignup(actor, tx, assignmentId, reason: string)`: personnel can cancel themselves any time before the job's `startAt`; at or after start it is refused (message `"This detail has started. Ask a coordinator to remove you."`); sets `canceled` and calls `openSpot` for that position.
  - `openSpot(tx, jobPositionId, now)` (called when a spot opens): if the job starts within `backupFirstComeHours` of `now`, reopen to backups and all eligible at once (first come, first served; alerts backups only); otherwise by `backupOfferMode`: `sequential` creates an offer to the first backup ending at `now + backupWindowMinutes` and alerts them; `all_backups` creates one offer to all backups for the window; `everyone` (or no backups) reopens the spot to all eligible at once.
  - `claimSpot(actor, tx, jobPositionId)`: during a `sequential` offer only the offered backup may claim; during an `all_backups` offer any backup on that position (first come); with no open offer, anyone eligible.
  - `backupOfferTick(now)`: an open offer on a job now within `backupFirstComeHours` of start ends and the spot opens first come, first served; an expired `sequential` offer moves to the next backup in order (new window, alert); after the last backup, or when an `all_backups` offer expires, the spot reopens to everyone (no broadcast alert).
  - `assignPerson(actor, tx, jobPositionId, userId, { overrideReason?: string; notify: boolean })`: runs `evaluateSignup`; failed checks require `overrideReason`.
  - `removePerson(actor, tx, assignmentId, comment: string)`: `removed`, alert to the person.
  - `markNoShow(actor, tx, assignmentId, note: string)`.
  - `restrictFromVendor(actor, tx, userId, vendorId, { reason: string; removeFromFutureDetails: boolean })` and `liftVendorRestriction(actor, tx, restrictionId, note?: string)` (coordinators and admins only; audited; no alert to the vendor)
  - `isRestricted(tx, userId, vendorId): Promise<boolean>` (feeds the `vendor_restricted` check with the message `"Not available to you. Contact a coordinator."`)
  - `vendorCancelJob` is in Task 29.

- [ ] **Step 1:** Tests: cancel opens the spot and the job shows the canceled person on the roster; a self-cancel one minute before start succeeds; a self-cancel one minute after start throws and a coordinator removal still works; in `sequential` mode backup 2 cannot claim during backup 1's 30-minute window, backup 1 can, and after the tick backup 2 is offered the spot; after the last backup's window a non-backup can claim; in `all_backups` mode any backup can claim during the window and a non-backup cannot; in `everyone` mode a non-backup can claim at once; changing `backupWindowMinutes` to 15 shortens new offers; a spot opening 11 hours before the start skips backup turns and any backup or eligible person can claim it; when a spot opens to everyone (after backup turns, or immediately inside 12 hours) every eligible watcher gets `job.watch_opened`; a watched job's release sends `job.watch_released` to its watchers only; an ineligible or restricted watcher gets nothing; signing up ends the watch; a watch that sent one alert is ended and the second opening alerts nobody until the deputy watches again; a sequential chain still running when the job reaches 12 hours out switches to first come, first served on the next tick; `assignPerson` over a cap without `overrideReason` throws and with it succeeds and audits the reason; `markNoShow` by personnel throws; a restricted deputy cannot sign up or join as backup for that vendor's jobs (other vendors unaffected), and `assignPerson` refuses them even with an override reason; `restrictFromVendor` with `removeFromFutureDetails` removes their future sign-ups for that vendor only; personnel and vendors cannot call either function; lifting restores access;
- [ ] **Step 2–4:** Run, implement, run.
- [ ] **Step 5:** Commit: `Add cancellation, backups and coordinator assignment actions`

## Phase 2: Billing

### Task 20: Billing rules

**Files:**
- Create: `src/domain/billing/rules.ts`
- Test: `tests/unit/billing/rules.test.ts`

**Interfaces:**
- Produces:
  - `roundMinutes(minutes: Minutes, step: number): Minutes` (always up to the next step)
  - `resolveMinimum(jobMin: Minutes | null, vendorMin: Minutes | null, agencyMin: Minutes): Minutes` (job override, then vendor override, then agency setting)
  - `billableMinutes(actual: Minutes, s: { minimumBillableMinutes: number; hourRoundingMinutes: number }): Minutes` (`minimumBillableMinutes` is the resolved value)
  - `invoiceTotal(minutes: Minutes, rateCents: Cents): Cents` (`Math.round(minutes * rateCents / 60)`)
  - `hoursChanged(planned: { startAt; endAt }, actual: { startAt; endAt }): boolean` (compares with the assignment's planned times, not the job's default times)
  - `reviewDecision(mode: 'immediate' | 'changed_hours_only' | 'all', changed: boolean): 'send' | 'hold'`

- [ ] **Step 1:** Tests: 6 h at $75.00 (`7500`) is `45000`; 4 h 30 m at $50 is `22500`; 6 h 30 m at $75 is `48750`; `roundMinutes(360, 15) === 360`, `roundMinutes(361, 15) === 375` and `roundMinutes(367, 15) === 375`; with the agency minimum 240, an actual 150 bills 240 and an actual 300 bills 300; `resolveMinimum(180, 120, 240) === 180`, `resolveMinimum(null, 120, 240) === 120`, `resolveMinimum(null, null, 240) === 240`; `reviewDecision('changed_hours_only', false) === 'send'`, `(…, true) === 'hold'`, `('all', false) === 'hold'`, `('immediate', true) === 'send'`.
- [ ] **Step 2–4:** Run, implement, run.
- [ ] **Step 5:** Commit: `Add billing rules`

### Task 21: Billing a detail

**Files:**
- Create: `src/domain/billing/bill.ts`, `src/app/api/v1/assignments/[id]/bill/route.ts`
- Test: `tests/integration/billing/bill.test.ts`

**Interfaces:**
- Consumes: billing rules, `createInvoice` (Task 22), `queueInvoiceEmail` (Task 23), `currentW9`.
- Produces: `billAssignment(actor, tx, assignmentId, input: { startAt: Date; endAt: Date; changeReason?: string; attachW9: boolean; paidOnSpot?: { method: 'check' | 'cash' | 'electronic'; reference: string } }): Promise<{ invoice: Invoice; delivery: 'sent_queued' | 'held_for_review' }>`

Rules: only the assignee (or a coordinator on their behalf); only after the job's scheduled `endAt`, except `late_canceled` assignments, which bill at once with minutes from `lateCancelMinutes` (Task 29), times not editable, invoice kind `late_cancel`; `endAt > startAt` (an end earlier on the clock than start means the next day only when the UI sends the next day's date; the service never guesses); change reason required when `hoursChanged`; `attachW9` with no current W-9 throws `RuleViolation("Upload your W-9 before attaching it")` before any write; a payee with no mailing address throws `RuleViolation("Add your mailing address in Profile before billing")` before any write; paid on spot records the deputy's paid mark (vendor confirmation still needed, Task 25) and still emails the invoice marked Paid.

- [ ] **Step 1:** Tests: billing before `endAt` throws; changed hours without reason throws; end before start throws `ValidationError("End must be after start")`; an 8 PM to 6 AM billed span across midnight bills 600 minutes; `attachW9` without W-9 throws and creates no invoice; in `changed_hours_only` mode unchanged hours returns `sent_queued` and changed returns `held_for_review`; paid on spot stores the deputy method and reference, leaves status `sent`, and sets `responsibleParty` to `vendor`; the assignment becomes `billed` (or `paid`).
- [ ] **Step 2–4:** Run, implement, run.
- [ ] **Step 5:** Commit: `Add billing of completed details`

### Task 22: Invoices and PDF

**Files:**
- Create: `src/domain/invoices/invoices.ts`, `src/lib/pdf/invoice-pdf.tsx`
- Test: `tests/integration/invoices/invoices.test.ts`, `tests/unit/pdf/invoice-pdf.test.ts`

**Interfaces:**
- Produces: `createInvoice(tx, input: { assignmentId; minutes; rateCents; status }): Promise<Invoice>` (number `ED-000001` style from a Postgres sequence and `invoiceNumberPrefix`), `renderInvoicePdf(data: InvoicePdfData): Promise<Buffer>`, `type InvoicePdfData = { number; revision; issuedAt; vendor: { name; billingEmails }; job: { number; title; location; startAt; endAt }; payee: { name; mailingAddress: string; email: string }; minutes; rateCents; totalCents; paid: { method; reference; paidAt } | null; replyTo: string }`.

PDF content: agency header from the agency profile setting (logo, agency name, "Sheriff <name>", address, phone, website), "Invoice" and number (with "Revised" and revision when > 0), "Pay to" block with payee name, mailing address and email, job details, hours worked, hours billed (with "4-hour minimum applied" when the minimum raised it, hours from the resolved minimum), rate, total, payment instructions "Make payment to the payee named above. Payment questions or disputes: <replyTo>", "PAID" with reference when paid.

- [ ] **Step 1:** Tests: numbers are sequential and unique under concurrent creation; the rendered PDF text (extract with `pdf-parse`) contains the number, payee name, `$450.00`, and the reply-to address; it contains "Revised" only when revision > 0; it contains the payee's mailing address and email; it shows the minimum note only when billed minutes exceed worked minutes; it contains the agency name and sheriff's name from settings and embeds the logo image when one is set (and renders without one).
- [ ] **Step 2–4:** Run, implement, run.
- [ ] **Step 5:** Commit: `Add invoice records and PDF rendering`

### Task 23: Email delivery

**Files:**
- Create: `src/lib/email/sender.ts`, `src/lib/email/templates/*.ts`, `src/domain/invoices/email.ts`, `src/jobs/email-worker.ts`
- Test: `tests/integration/email/invoice-email.test.ts`

**Interfaces:**
- Produces: `EmailSender` interface with adapters `smtpSender` (Nodemailer) and one adapter per API provider (`postmarkSender`, `sesSender`, `sendgridSender`, `mailgunSender`, each a small HTTPS client), chosen by `settings.email.provider` (no host-specific code, so any host works); `jsonTransport` in tests), `queueEmail(tx, msg: OutgoingEmail)` (pg-boss, retry 6 times with exponential backoff), `queueInvoiceEmail(tx, invoiceId)`, `type OutgoingEmail = { to: string[]; replyTo?: string; subject: string; text: string; html: string; attachments?: Array<{ filename: string; content: Buffer; contentType: string }> }`.

Invoice email: to vendor billing emails; reply-to `billingReplyToEmail`; subject `Invoice ED-000123 for job #69344`; attachments invoice PDF and, when `attachW9`, the decrypted W-9 as `W-9 <Payee Name>.pdf`.

- [ ] **Step 1:** Tests: a queued invoice email is delivered with two attachments when `attachW9`; reply-to equals the setting; with an SMTP transport that throws, the invoice `emailStatus` stays `queued`, the job retries, and after the final failure it is `failed` and the payee and coordinators get a `invoice.email_failed` alert; each API adapter sends the same message shape to a mocked endpoint with attachments; sending with empty `billingReplyToEmail` or an unconfigured provider fails fast with a settings error shown to coordinators.
- [ ] **Step 2–4:** Run, implement, run.
- [ ] **Step 5:** Commit: `Add SMTP email delivery and invoice emails`

### Task 24: Invoice review

**Files:**
- Create: `src/domain/invoices/review.ts`, `src/app/api/v1/invoices/**/route.ts`
- Test: `tests/integration/invoices/review.test.ts`

**Interfaces:**
- Produces: `approveInvoice(actor, tx, id)`, `editInvoice(actor, tx, id, { startAt?; endAt?; rateCents?; minimumBillableMinutes?: Minutes; reason: string })` (the minimum override applies to this invoice only) (recomputes; if already sent, increments `revision` and re-sends as Revised), `sendBackInvoice(actor, tx, id, comment?: string)` (presets context `send_back`) (status `returned`; assignment back to `signed_up`; the person re-bills; the same invoice number is reused on re-bill), `listInvoicesForReview(actor, tx)`.

- [ ] **Step 1:** Tests: personnel cannot approve; approve queues the email; edit without reason throws; editing a sent invoice sets revision 1 and queues a Revised email; send back alerts the person and their re-bill reuses the number; every action audits.
- [ ] **Step 2–4:** Run, implement, run.
- [ ] **Step 5:** Commit: `Add coordinator invoice review`

### Task 25: Payment tracking and billing history

**Files:**
- Create: `src/domain/billing/payments.ts`, `src/domain/billing/history.ts`, `src/app/api/v1/billing/**/route.ts`
- Test: `tests/integration/billing/payments.test.ts`

**Interfaces:**
- Produces:
  - `paymentResponsibility(inv: { status; deputyPaidAt; vendorPaidAt }, openIssue: { waitingOn } | null): 'deputy' | 'coordinator' | 'vendor' | null`: `pending_review` gives coordinator; `returned` gives deputy; `paid` or `written_off` gives null; an open issue gives its `waitingOn`; vendor marked and deputy not gives deputy; otherwise vendor (to pay, or to confirm a deputy mark).
  - `applyResponsibility(tx, invoiceId, now)`: recomputes and, when the party changes, sets `responsibleParty`, `responsibleSince = now` and writes an `invoice_events` row. Every service that changes an invoice or issue calls it.
  - Notes on every payment step are optional: each call below takes `note?: string` (free text or a preset's text from `note_presets`, the UI offers the presets for that step's context); the note goes on the timeline event.
  - `markPaid(actor, tx, invoiceId, { paymentMethodId; reference; paidAt: Date; note?: string })` (the payee; sets `deputyPaid*`; status becomes `paid` only when `vendorPaidAt` is also set; then closes open issues as `paid`)
  - `vendorMarkPaid(actor, tx, invoiceId, { paymentMethodId; reference; paidAt: Date; note?: string })` (vendor of the invoice; sets `vendorPaid*`; alerts the payee "Vendor reports paid"; status becomes `paid` only when `deputyPaidAt` is also set)
  - `coordinatorCloseInvoice(actor, tx, invoiceId, { outcome: 'paid' | 'written_off'; reason: string })` (coordinator; for a side that never responds)
  - `invoiceTimeline(actor, tx, invoiceId): Promise<InvoiceEvent[]>` (payee, vendor of the invoice, coordinators)
  - `responsibleDueAt(party, since: Date, s: { responseDays }): Date` (`since + responseDays[party]` days) and `isOverdue(inv, now, s): boolean`; both are shown wherever responsibility is shown
  - `billingHistory(actor, tx, filter: { from; to; vendorId? }): Promise<{ totals: { count; minutes; earnedCents; paidCents; waitingCents }; byMonth: Array<{ month: string; earnedCents: Cents }>; rows: HistoryRow[] }>` (own invoices; coordinators for anyone), `exportBillingCsv(actor, tx, filter): Promise<string>`. Agency reports, dashboards and tax summaries are Task 34.

- [ ] **Step 1:** Tests: `markPaid` and `vendorMarkPaid` succeed with no note and store a given note on the timeline; `paymentResponsibility` returns each row of spec 12.10's table; a sent invoice starts as `vendor`; `vendorMarkPaid` moves it to `deputy`, leaves status `sent`, alerts the payee, and is refused for another vendor's invoice; then `markPaid` by the payee makes it `paid` with responsibility null; a deputy-only mark leaves it `sent` and `vendor`; every change writes one timeline event and `responsibleSince` updates only when the party changes; `coordinatorCloseInvoice` without a reason throws; another person cannot mark someone's invoice paid; when every invoice on a job is `paid` or `written_off`, `deriveJobStatus` returns `closed`; totals for the sample set (45000 paid, 48750 + 60000 waiting) are `earnedCents 153750`, `paidCents 45000`, `waitingCents 108750`; CSV has a header row and one row per invoice.
- [ ] **Step 2–4:** Run, implement, run.
- [ ] **Step 5:** Commit: `Add payment tracking and billing history`

## Phase 3: Alerts and messages

### Task 26: Notification core

**Files:**
- Create: `src/domain/notifications/notify.ts`, `src/domain/notifications/types.ts`, `src/domain/notifications/prefs.ts`, `src/lib/push/push.ts`, `src/jobs/notification-worker.ts`
- Test: `tests/integration/notifications/notify.test.ts`

**Interfaces:**
- Produces:
  - `type NotificationType` (union of every row in spec section 14 plus `invoice.email_failed`, `user.suspended`, `job.safety_changed` (to everyone signed up or on backup), `signup.short_confirmed`, `signup.short_declined`, `job.watch_opened`, `job.watch_released`)
  - `emit(tx, event: { type: NotificationType; recipients: string[]; title: string; body: string; link: string; mandatory?: boolean })` (writes inbox rows in the transaction; enqueues email and push after commit)
  - `setPreference(actor, tx, type, { email: boolean; push: boolean })`, `setQuietHours(actor, tx, { start: 'HH:MM'; end: 'HH:MM' } | null)`
  - `subscribePush(actor, tx, subscription: PushSubscriptionJSON)`, `markRead(actor, tx, ids)`

Rules: inbox always gets the row; email and push follow preferences; `mandatory` (coordinator-sent) ignores preferences and quiet hours; non-mandatory push during quiet hours is held until quiet hours end; push subscriptions returning 404 or 410 are deleted.

- [ ] **Step 1:** Tests: a recipient with email off gets an inbox row and no email; mandatory goes through quiet hours; a 410 from the push service removes the subscription; nothing is sent if the transaction rolls back.
- [ ] **Step 2–4:** Run, implement, run.
- [ ] **Step 5:** Commit: `Add inbox, email and push notifications`

### Task 27: Automatic alerts wiring

**Files:**
- Modify: release, jobs, signup, cancel/backups, coordinator actions, billing, review services to call `emit`
- Create: `src/domain/notifications/audiences.ts`
- Test: `tests/integration/notifications/wiring.test.ts`

**Interfaces:**
- Produces: `jobAudience(tx, job): Promise<string[]>` (people signed up, pending or on backup for the job). Alerts go only to people who need to act or whose own detail changed (spec 14); nothing is broadcast at release, posting or reopening.

- [ ] **Step 1:** Tests, one per spec section 14 row: the right type reaches the right recipients (for example a rate change reaches the people signed up and on backup and nobody else; a release at the 15th 4:00 PM sends nothing; a backup turn reaches only that backup; vendor requests reach coordinators).
- [ ] **Step 2–4:** Run, implement, run.
- [ ] **Step 5:** Commit: `Send automatic alerts for job and billing events`

### Task 28: Messages

**Files:**
- Create: `src/domain/messages/messages.ts`, `src/app/api/v1/messages/**/route.ts`
- Test: `tests/integration/messages/messages.test.ts`

**Interfaces:**
- Produces:
  - `type Audience = { kind: 'all' } | { kind: 'users'; userIds: string[] } | { kind: 'rank'; rankIds: string[] } | { kind: 'job'; jobId } | { kind: 'coordinators' }`
  - `sendMessage(actor, tx, { audiences: Audience[]; subject: string; body: string; jobId?: string; replyToMessageId?: string })` (personnel, coordinators and admins; vendors refused; `all` allowed for personnel only when setting `personnelCanMessageAll` is true; recipients are the de-duplicated union minus the sender and never include vendor users; a `users` audience naming a vendor user is refused; mandatory when the sender is a coordinator or admin)
  - `messageCoordinators(actor, tx, { jobId; body })`
  - `listInbox(actor, tx, { text?; unreadOnly?; page })`, `listSent`, `markRead(actor, tx, ids, read: boolean)`, `hideMessages(actor, tx, ids)` (removes from that user's view only)
  - Notification type `message.received`; its email preference (default off) sends the full subject and body, with a link to reply in the app
- Settings: `personnelCanMessageAll` default true (coordinators can change).

- [ ] **Step 1:** Tests: a deputy messages two selected users and both get an inbox row and a push, the deputy does not; a deputy messages all users when allowed, and is refused when `personnelCanMessageAll` is false; a recipient with `message.received` email on gets an email containing the body, one with it off gets none; a coordinator message reaches someone with email off by email too (mandatory); a vendor cannot send; a deputy naming a vendor login as a recipient is refused and `all` never reaches vendor users; job audience includes signed-up people and backups only; overlapping audiences send one copy each; hiding a message removes it from that user's inbox but not the sender's Sent or the audit; mark unread works.
- [ ] **Step 2–4:** Run, implement, run.
- [ ] **Step 5:** Commit: `Add message center for users and coordinators`

## Phase 4: Vendor portal, locks, issues, ops plans

### Task 29: Vendor portal services

**Files:**
- Create: `src/domain/vendor-portal/requests.ts`, `src/domain/vendor-portal/rules.ts`
- Test: `tests/unit/vendor-portal/rules.test.ts`, `tests/integration/vendor-portal/requests.test.ts`

**Interfaces:**
- Produces:
  - `vendorEditAllowed(input: { now; job: { startAt; signedUpCount }; change: 'time' | 'date' | 'headcount_up' | 'headcount_down' | 'description' | 'cancel'; s: VendorSettings }): { allowed: boolean; needsApproval: boolean; reason?: string }`
  - `submitRequest(actor, tx, input: VendorRequestInput)` (includes `positions`, optional `flex`, optional `safety`, an optional contract file or link like `JobInput`, and an optional `dates: DateSelection` so one request covers many dates; `approveRequest` approves the whole set, and either `locationId` of one of their active locations or `newLocation: { name; address; notes? }`, which creates the location first; defaults to one position of `defaultPositionTypeId`) (state `requested`; refused inside `vendorMinNoticeHours` or while the vendor is on payment hold)
  - `approveRequest(actor, tx, jobId, edits?: Partial<JobInput>)` (state `scheduled`), `declineRequest(actor, tx, jobId, reason)`
  - `vendorEditJob(actor, tx, jobId, patch)` (applies or creates a pending change; alerts signed-up people on approval)
  - `vendorCancelJob(actor, tx, jobId, reason)` (vendor or coordinator acting for the vendor; sets `canceledByVendor`; when `startAt - now <= lateVendorCancelHours`, every `signed_up` assignment becomes `late_canceled` and is billable at once)
  - `lateCancelMinutes(job, s): Minutes` (`lateCancelPayBasis` `minimum` gives the resolved minimum billable minutes; `scheduled` gives the job's scheduled minutes)
  - `waiveLateCancelPay(actor, tx, jobId, reason: string)` (coordinator and admin; `late_canceled` assignments become `canceled`, unbilled ones only; people are alerted)
  - `vendorViewJob(actor, tx, jobId)` (full names of assigned personnel only when filled and `vendorSeesAssignedNames`, each with their planned times; never phone or email)

- [ ] **Step 1:** Tests: `vendorEditAllowed` with defaults refuses any change within 24 h; refuses headcount down once someone is signed up when `vendorEditsAfterSignup` is `none`; time change needs approval; a vendor request may only use position types marked `vendorRequestable` (Incident Commander and Dispatcher are requestable by default; a type a coordinator unmarks is refused) and the vendor view never lists flag holders; `qualificationHolderCount(tx, qualificationId)` is available to coordinators only; a vendor cannot read another vendor's job (`NotFoundError`, not `ForbiddenError`, to avoid leaking existence); a vendor on payment hold cannot submit, edit or view-open details; their future jobs show as `on_hold`, refuse sign-ups and backups with "Vendor on payment hold", and disappear from open lists; existing sign-ups remain, are marked locked on their calendar and job page, cannot bill, and are alerted; after `resolvePaymentHold` with `fix_coming` they reopen under the release rules; `lockedDetailsForTodo(tx, now)` returns locked jobs that have started (action needed) and those starting within 24 hours (heads-up), and never cancels anything itself; `cancelJob` on a locked job with reason `vendor_hold` makes every signed-up assignment `late_canceled` (billable at the minimum, invoice kind `late_cancel`, responsibility `vendor`) when the hold's `placedAt` is within `lateVendorCancelHours` of the job's start, and otherwise creates no pay unless `applyLateCancelPay: true` is passed; a hold placed 30 hours before the start then canceled creates nothing, and a hold placed 10 hours before creates a 240-minute late cancellation invoice per deputy; a vendor cancel 23 h before start makes two signed-up deputies `late_canceled` and each can bill 240 minutes at the job rate with invoice kind `late_cancel`; a cancel 25 h before start creates nothing billable; personnel `waiveLateCancelPay` throws and a coordinator waive with reason works and alerts both deputies.
- [ ] **Step 2–4:** Run, implement, run.
- [ ] **Step 5:** Commit: `Add vendor requests, edits and cancellations`

### Task 30: Unbilled reminders, billing lock and payment acknowledgment lock

**Files:**
- Create: `src/domain/billing/lock.ts`, `src/jobs/unbilled-reminders.ts`
- Modify: `src/domain/assignments/signup.ts` (use the real `BillingLockReader`)
- Test: `tests/unit/billing/lock.test.ts`, `tests/integration/billing/reminders.test.ts`

**Interfaces:**
- Produces:
  - `billingLockStatus(input: { unbilled: Array<{ endAt: Date }>; unacknowledged: Array<{ sentAt: Date; deputyPaidAt: Date | null; responsibleParty: 'deputy' | 'coordinator' | 'vendor' | null; responsibleSince: Date | null; hasOpenIssue: boolean }>; now: Date; s: { unbilledGraceHours; billingLockEnabled; paymentAckLockMode; responseDays }; override: { until: Date } | null }): { locked: boolean; unbilledCount: number; unacknowledgedCount: number }`. An invoice is overdue for acknowledgment when, in `vendor_reported` mode, `responsibleParty === 'deputy'` and `responsibleSince + responseDays.deputy <= now`; in `all_invoices` mode, additionally any sent invoice with no `deputyPaidAt`, no open issue and `sentAt + responseDays.vendor + responseDays.deputy <= now`.
  - `realBillingLockReader: BillingLockReader` (replaces `noBillingLock` in Task 18; `count` in the Task 17 message becomes the two counts, messages `"Bill 2 past details to sign up again"` and `"Confirm payment on 1 invoice to sign up again"`)
  - `reminderDue(lastSentAt: Date | null, frequency, now): boolean` (daily 24 h, every other day 48 h, weekly 168 h), `overrideBillingLock(actor, tx, userId, { reason; until: Date })`, worker `unbilledRemindersTick(now)` (one email per person listing unbilled details and invoices waiting for payment confirmation, with links).

- [ ] **Step 1:** Tests: a detail ended 23 h ago with grace 24 does not lock; 25 h ago locks with `unbilledCount` 1; lock disabled never locks for unbilled; a vendor-marked-paid invoice 29 days old does not lock and 30 days old locks with `unacknowledgedCount` 1 in `vendor_reported` mode; in that mode an unpaid invoice with no vendor mark never locks; in `all_invoices` mode a sent invoice 30 days old locks; an open payment issue clears the item in both modes; mode `off` never locks for payment; an override until tomorrow unlocks; `reminderDue(null, …)` is true; every-other-day after 47 h is false and after 48 h true; billing the last detail or marking the last invoice paid unlocks immediately (integration through `eligibilityFor`).
- [ ] **Step 2–4:** Run, implement, run.
- [ ] **Step 5:** Commit: `Add unbilled detail reminders and sign-up lock`

### Task 31: Payment issues

**Files:**
- Create: `src/domain/payment-issues/issues.ts`, `src/jobs/vendor-reminders.ts`
- Test: `tests/integration/payment-issues/issues.test.ts`

**Interfaces:**
- Produces: `canReportNonPayment(invoice, now, s): boolean` (status `sent`, no `deputyPaidAt`, and either `responsibleParty === 'vendor'` past `responsibleDueAt`, or `vendorPaidAt` set (the deputy says it never arrived), no open issue), `reportNonPayment(actor, tx, invoiceId, note?: string)`, `addIssueNote(actor, tx, issueId, note: string)`, `closeIssue(actor, tx, issueId, outcome: 'paid' | 'resolved' | 'written_off', note?: string)` (note required only for `written_off`), `setIssueWaitingOn(actor, tx, issueId, party: 'coordinator' | 'vendor' | 'deputy', note?: string)` (coordinator; moves responsibility through `applyResponsibility` and alerts that party), `vendorIssueHistory(actor, tx, vendorId)`, worker `responseDeadlinesTick(now)`: for each invoice whose party just passed `responsibleDueAt`, writes an `overdue` timeline event once, then vendor: reminder email to the vendor when `vendorReminderEnabled` (from the agency, reply-to billing address); coordinator: alert to all coordinators and admins; deputy: nothing here (the lock in Task 30 handles it).

- [ ] **Step 1:** Tests: reporting while the vendor is inside its 30-day response time throws and on day 30 succeeds; reporting is allowed when the vendor has marked it paid on their side but the payee has not, and the issue shows the vendor's paid note; reporting alerts coordinators with the invoice link; the person sees status and notes but not internal-only fields; a new issue makes responsibility `coordinator`; `setIssueWaitingOn(..., 'vendor', note)` makes it `vendor` and alerts the vendor; both sides marking paid closes the issue as `paid`; every step is on the invoice timeline; vendor reminder sends once when the vendor goes overdue and never when disabled; a coordinator-owned issue untouched for 7 days alerts all coordinators and admins once and shows as overdue; changing `responseDays.coordinator` to 3 moves that deadline.
- [ ] **Step 2–4:** Run, implement, run.
- [ ] **Step 5:** Commit: `Add payment issue reporting and vendor reminders`

### Task 32: Ops plans

**Files:**
- Create: `src/domain/ops-plans/ops-plans.ts`, `src/jobs/ops-plan-reminders.ts`
- Test: `tests/integration/ops-plans/ops-plans.test.ts`

**Interfaces:**
- Produces: `currentIc(tx, jobId): Promise<string | null>` (the person signed up for a position whose type `isIncidentCommander`, else the roster member flagged `isIncidentCommander`), `nameIc(actor, tx, jobId, userId)` (coordinator; person must be on the roster and hold the Incident Commander qualification), `opsPlanDueAt(job, icAssignedAt): Date` (the job's due date, or the job's start when the IC is assigned after the due date), `submitOpsPlan(actor, tx, jobId, file)` (current IC only; new version; status `submitted`; alerts reviewers), `reviewOpsPlan(actor, tx, opsPlanId, { decision: 'agreed' | 'denied'; comments: string })` (only users in `opsPlanReviewerUserIds`, never the submitting IC; `denied` requires comments and alerts the IC), worker `opsPlanRemindersTick(now)` (due soon and overdue to IC and coordinators; submitted plans not yet reviewed remind the reviewers once a day until reviewed).

- [ ] **Step 1:** Tests: a non-IC cannot submit; when the IC cancels, `currentIc` changes and the task follows; a reviewer who is also the IC is refused on their own plan; a non-reviewer coordinator is refused; deny without comments throws; a resubmission creates version 2 and alerts reviewers again; an IC assigned after the due date has until the detail's start; an unreviewed plan reminds reviewers once a day until reviewed.
- [ ] **Step 2–4:** Run, implement, run.
- [ ] **Step 5:** Commit: `Add ops plan submission and review`

### Task 33: Ops plan library and deputy notes

**Files:**
- Create: `src/domain/ops-plans/library.ts`, `src/db/schema/deputy-notes.ts` (`deputy_notes` (vendorId, locationId nullable, body, status enum `pending`/`approved`/`denied`/`retired`, submittedBy, submittedFromJobId, submittedAt, reviewedBy, reviewedAt, reviewComment nullable)) plus migration, `src/domain/deputy-notes/deputy-notes.ts`, `src/app/api/v1/deputy-notes/**/route.ts`
- Test: `tests/integration/ops-plans/library.test.ts`, `tests/integration/deputy-notes/deputy-notes.test.ts`

**Interfaces:**
- Produces: `searchLibrary(actor, tx, { text?; vendorId?; year?; location? }, page)` (agreed plans only; personnel, coordinators, admins), `suggestPriorPlan(tx, { vendorId; title; startAt }): Promise<OpsPlanSummary | null>` (same vendor, title similarity >= 0.6 by Postgres `pg_trgm`, previous year first).
- Produces (deputy notes):
  - `submitDeputyNote(actor, tx, { jobId; body: string; scope: 'vendor' | 'location' })` (personnel who are or were assigned to that job; status `pending`; alerts coordinators with `deputyNote.submitted`)
  - `reviewDeputyNote(actor, tx, noteId, { decision: 'approve' | 'deny'; editedBody?: string; comment?: string })` (coordinators and admins; alerts the author with `deputyNote.approved` or `deputyNote.denied`)
  - `editDeputyNote`, `retireDeputyNote` (coordinators and admins; audited)
  - `deputyNotesForJob(actor, tx, jobId): Promise<Array<{ body; authorName; writtenAt }>>` (`authorName` is the author's first and last name; `writtenAt` is `submittedAt`, the date the author wrote it, shown with the note) (approved notes for the job's vendor plus its location; personnel, coordinators and admins only; vendor actors get `ForbiddenError`)

- [ ] **Step 1:** Tests: denied or pending plans never appear; vendor actors cannot search; `suggestPriorPlan` for "Harborfront Mardi Gras Parade" 2027 returns the 2026 agreed plan for the same vendor and nothing for a different vendor; a deputy never assigned to the job cannot submit a note; a pending note shows on no job; after approval with an edited body it shows the edited text on every current and future job for that vendor, and a location-scoped note only on jobs at that location; a denied note never shows and the author is alerted; a retired note stops showing; a vendor actor calling `deputyNotesForJob` gets `ForbiddenError` and `vendorViewJob` contains no deputy notes.
- [ ] **Step 2–4:** Run, implement, run.
- [ ] **Step 5:** Commit: `Add ops plan library and deputy notes`

### Task 34: Earnings dashboards, tax summaries and reports

**Files:**
- Create: `src/domain/reports/earnings.ts`, `src/domain/reports/tax.ts`, `src/domain/reports/datasets.ts`, `src/domain/reports/engine.ts`, `src/domain/reports/saved.ts`, `src/lib/pdf/report-pdf.tsx`, `src/app/api/v1/reports/**/route.ts`
- Test: `tests/integration/reports/earnings.test.ts`, `tests/integration/reports/tax.test.ts`, `tests/integration/reports/engine.test.ts`

**Interfaces:**
- Produces:
  - `earningsDashboard(actor, tx, userId, now): Promise<{ thisMonth: Totals; thisYear: Totals; outstandingCents: Cents; byYear: Array<{ year: number } & Totals> }>` where `Totals = { details: number; minutes: Minutes; billedCents: Cents; paidCents: Cents }`. Billed totals use the detail's agency date; paid totals use `deputyPaidAt`. Own data; coordinators for anyone.
  - `taxYearSummary(actor, tx, userId, year): Promise<{ year; payee: { name; mailingAddress }; byVendor: Array<{ vendorName; paidCents: Cents; details: number }>; totalPaidCents: Cents; unpaidBilledCents: Cents; rows: TaxRow[] }>` (cash basis: counted in the year the deputy marked it received; each `TaxRow` has `deputyPaidAt`, `vendorPaidAt` and `yearMismatch: boolean` when the two fall in different calendar years in agency time), `exportTaxSummary(actor, tx, userId, year, format: 'pdf' | 'csv'): Promise<Buffer>` (PDF uses the agency header).
  - `type DatasetName = 'jobs' | 'assignments' | 'invoices' | 'payments' | 'payment_issues' | 'cancellations' | 'no_shows' | 'vendor_requests' | 'ops_plans' | 'locks_and_overrides' | 'suspensions' | 'messages' | 'audit'` (`audit` covers every recorded action, so every event in the system is reportable)
  - `type ReportSpec = { dataset: DatasetName; from: Date; to: Date; filters: { userIds?: string[]; vendorIds?: string[]; typeIds?: string[]; locationIds?: string[]; statuses?: string[] }; groupBy: Array<'day' | 'week' | 'month' | 'year' | 'deputy' | 'vendor' | 'job_type' | 'location' | 'status'>; measures: Array<'count' | 'hours' | 'billed_cents' | 'paid_cents' | 'outstanding_cents'> }`
  - `runReport(actor, tx, spec: ReportSpec): Promise<{ columns: string[]; rows: unknown[][]; totals: Record<string, number> }>` (coordinators and admins; time grouping in agency time; each dataset declares which groupings and measures it supports and rejects others with `ValidationError`)
  - `exportReport(actor, tx, spec, format: 'csv' | 'pdf'): Promise<Buffer>`
  - `saveReport(actor, tx, name: string, spec: ReportSpec)`, `listSavedReports(actor, tx)`, `deleteSavedReport(actor, tx, id)`
  - Built-in saved reports (seeded): Agency billed and paid by day, by month, by year; Earnings by deputy for a period; Billing by vendor; Unpaid invoices by responsible party and age; Cancellations, late cancellations and no shows by deputy; Fill rate by month (filled versus expired); Hours by deputy against caps; Ops plans by status.

- [ ] **Step 1:** Tests: with a fixture year, `earningsDashboard` this month and this year match hand-computed totals; an invoice for a Dec 28, 2026 detail marked received Jan 5, 2027 counts as billed in 2026 and paid in 2027, and appears in the 2027 tax summary under its vendor; when the vendor marked it paid Dec 30, 2026 and the deputy received it Jan 5, 2027, the row has `yearMismatch: true`; a deputy calling `taxYearSummary` for another deputy throws `ForbiddenError` and a coordinator succeeds; `runReport` on `invoices` grouped by `month` and `deputy` with `billed_cents` matches the fixture; a day boundary uses agency time (a 11:30 PM Central detail on Nov 30 groups in November); `audit` dataset grouped by `day` counts every recorded action; an unsupported grouping throws; personnel cannot run agency reports; CSV export has a header row; PDF export contains the agency name.
- [ ] **Step 2–4:** Run, implement, run.
- [ ] **Step 5:** Commit: `Add earnings dashboards, tax summaries and agency reports`

### Task 35: Personal schedule, sorting, goals, recommendations and hidden vendors

**Files:**
- Create: `src/db/schema/planning.ts` (`work_schedules` (userId, kind enum `weekly`/`rotation`, weekdays int[] nullable, cycle text nullable e.g. `11001110011000`, anchorDate, shiftStart `HH:MM`, shiftEnd `HH:MM`, bufferMinutes int in (0, 15, 30, 45, 60), active), `schedule_exceptions` (userId, date, kind enum `off`/`extra`, shiftStart, shiftEnd), `earnings_goals` (userId, monthlyCents), `hidden_vendors` (userId, vendorId), `calendar_feeds` (userId, urlEnc, lastFetchedAt, lastError), `calendar_busy` (feedId, startAt, endAt, title)) plus migration
- Create: `src/domain/planning/schedule.ts`, `src/domain/planning/recommend.ts`, `src/domain/planning/preferences.ts`, `src/app/api/v1/me/**/route.ts`
- Modify: `src/domain/jobs/jobs.ts` (`listJobs` sort and filters), `src/domain/notifications/audiences.ts` (exclude hidden vendors)
- Test: `tests/unit/planning/schedule.test.ts`, `tests/unit/planning/recommend.test.ts`, `tests/integration/planning/planning.test.ts`

**Interfaces:**
- Produces:
  - `dutyIntervals(schedules: WorkSchedule[], exceptions: ScheduleException[], from: Date, to: Date): Array<{ startAt: Date; endAt: Date }>` (agency time; weekly patterns by weekday; rotation by `(daysSince(anchorDate) mod cycle.length)` where `'1'` is a work day; a shift whose end is not after its start ends the next day; `off` exceptions remove that day's shift, `extra` adds one; each interval widened by `bufferMinutes` on both sides)
  - `bestPlacement(job: { startAt; endAt; flex?: { earliestStartAt; latestEndAt; allowShorter } }, busy: Array<{ startAt; endAt }>): { startAt: Date; endAt: Date } | null` (the default times if they fit; otherwise the earliest placement inside the flex range, in 15-minute steps at the default length, that fits; null if none)
  - `parseIcsBusy(ics: string, from: Date, to: Date): Array<{ startAt: Date; endAt: Date; title: string }>` (titles kept so the deputy sees what conflicts; private to them) (ical.js; expands recurring events; honors time zones; skips `TRANSP:TRANSPARENT` and cancelled events; all-day events block the whole agency day)
  - `setCalendarFeed(actor, tx, url: string | null)` (https only; stored with `encryptSecret`), worker `calendarFeedsTick(now)` (once a day per feed, plus `syncCalendarNow(actor, tx)` at most once per 15 minutes; fetch with a 10-second timeout and 5 MB limit, refusing private, loopback and link-local addresses; replaces that feed's `calendar_busy` rows for the next 90 days; records `lastError` and leaves old rows on failure); busy blocks are merged into the duty intervals; when `capHoursMode` is `details_plus_schedule`, the deputy's work-schedule shifts (not calendar events) are added to `existing` in `evaluateCaps` through the eligibility reader
  - `fitsSchedule(job, duty): boolean` (true when `bestPlacement` returns a placement)
  - `setWorkSchedule(actor, tx, input)`, `addScheduleException`, `setEarningsGoal(actor, tx, monthlyCents: Cents | null)`, `hideVendor(actor, tx, vendorId)`, `unhideVendor(actor, tx, vendorId)` (own data only; never visible to other users, coordinators included)
  - `listJobs` filter gains `onlyWorkable?: boolean` and `sort?: 'date' | 'vendor' | 'location' | 'rate' | 'total_pay'` with `direction`; hidden vendors are always excluded from personnel lists
  - `goalProgress(actor, tx, now): Promise<{ goalCents: Cents | null; earnedCents: Cents; signedUpCents: Cents; remainingCents: Cents }>` (this agency month; signed up counts scheduled pay at billable minutes)
  - `recommendDetails(input: { candidates: Array<{ jobPositionId; startAt; endAt; totalCents: Cents }>; remainingCents: Cents; existing: Array<{ startAt; endAt }>; duty: Array<{ startAt; endAt }>; capCheck: (picked: Array<{ startAt; endAt }>) => boolean }): string[]` (candidates already filtered to eligible, released, open, not hidden; considered in start time order, soonest first, each at its `bestPlacement`; skip overlaps with existing, duty or already picked; skip when `capCheck` fails; stop once picked total >= `remainingCents`; returns jobPositionIds)
  - `recommendationsFor(actor, tx, now): Promise<Array<JobSummary & { totalCents: Cents }>>`

- [ ] **Step 1:** Tests: a 2-2-3 rotation anchored Mon Nov 2, 2026 with cycle `11001110011000` and 6:00 PM to 6:00 AM shifts works Nov 2 and 3, is off Nov 4 and 5, works Nov 6, 7 and 8, and its Nov 2 shift ends 6:00 AM Nov 3; weekly Mon to Fri 8:00 AM to 5:00 PM has no interval on Saturday; an `off` exception removes that day; a 1-hour buffer makes a detail starting 5:30 PM not fit after a 5:00 PM shift end and a 15-minute buffer lets it fit; a buffer of 20 is rejected; a 5:00 PM to 11:00 PM detail with flex to 12:00 AM fits a deputy whose shift plus buffer ends 5:45 PM, at 5:45 PM to 11:45 PM; `listJobs({ onlyWorkable: true })` hides an overlapping detail and `sort: 'total_pay'` orders 6 h at $75 ($450) before 4 h at $100 ($400); a hidden vendor's job, and a job of a vendor the deputy is restricted from, never appears for that deputy in `listJobs` or recommendations, and a coordinator can still assign them; with $500 remaining and candidates Nov 3 $300, Nov 5 $450, Nov 5 $400 overlapping the $450 one, and Nov 9 $200, `recommendDetails` returns Nov 3 $300 and Nov 5 $450 (soonest first, stops once $500 is reached, skips the overlap); a candidate that would break the rolling 16-hour cap is skipped; another user cannot read someone's schedule (`ForbiddenError`, coordinators included); a sample Outlook ICS with a weekly recurring meeting, a Free event and an all-day event yields busy blocks for the meeting occurrences and the all-day date only; a feed URL resolving to 10.0.0.5 is refused; a feed that returns 500 keeps the previous busy blocks and records the error.
- [ ] **Step 2–4:** Run, implement, run.
- [ ] **Step 5:** Commit: `Add personal schedules, job sorting, earnings goals and hidden vendors`

## Phase 5: Interface

Visual reference: mockup row D (docs/mockups/project/). Each screen task ends with a Playwright test of its main path at 390x844 and 1280x900, in day and night themes, plus an axe accessibility check with no serious violations.

### Task 36: Design system, themes, shells, PWA

**Files:**
- Create: `src/ui/tokens.css`, `src/ui/theme.tsx`, `src/ui/components/*` (Button, Card, Chip, StatTile, Table, StaffingGrid, CheckList, EmptyState, FormField, PayLabel), `src/app/(app)/layout.tsx` (phone tab bar, desktop top nav), `public/manifest.webmanifest`, `src/app/sw.ts` (push and offline shell)
- Test: `tests/e2e/shell.spec.ts`, `tests/unit/ui/staffing-grid.test.tsx`

**Interfaces:**
- Produces: CSS variables for both themes (day: background `#F4F6F8`, surface `#FFFFFF`, border `#E3E6EB`, text `#14181F`, muted `#5B6472`, accent `#2147C2`; night: background `#0F1318`, surface `#171C23`, border `#2A313B`, text `#E8ECF1`, muted `#9AA4B2`, accent button `#3D6BF0`, link `#8FB0FF`), Inter font, `ThemeToggle` (system default, override stored per user in profile and in a cookie), `StaffingGrid({ positions: Array<{ name: string; filled: number; requested: number; backups: number }> })` (one labeled row of squares per position; solid squares filled, outlined open, dashed backups; `role="img"` with an `aria-label` like "17 of 17 spots filled, 2 backups waiting").
- `PayLabel({ totalCents: Cents; rateCents: Cents })` renders "$280 at $70/hr" and is the only way screens show a detail's pay (lists, cards, map pins, summaries).
- [ ] **Step 1:** Tests: `PayLabel({ totalCents: 28000, rateCents: 7000 })` renders "$280 at $70/hr" and `{ 45000, 7500 }` renders "$450 at $75/hr"; StaffingGrid for Dispatcher 1/1, Incident Commander 1/1, Deputy Sheriff 14/14 with 2 backups, CSO 1/1 renders four labeled rows and 19 squares with the aria-label "17 of 17 spots filled, 2 backups waiting"; the shell shows the bottom tab bar under 768 px and top nav above; theme follows `prefers-color-scheme` until toggled; manifest is served.
- [ ] **Step 2–4:** Run, implement, run.
- [ ] **Step 5:** Commit: `Add design system, themes, app shell and PWA manifest`

### Task 37: Personnel screens

**Files:**
- Create: `src/app/(app)/home/page.tsx`, `src/app/(app)/jobs/page.tsx`, `src/app/(app)/jobs/[id]/page.tsx`, `src/app/(app)/calendar/page.tsx`, `src/app/(app)/map/page.tsx` (Leaflet with `mapTileUrl` and `mapAttribution`; pins for details matching the list filters; tapping a pin opens a card linking to the job), `src/app/api/v1/calendar.ics/route.ts`, `src/app/(app)/billing/**`, `src/app/(app)/profile/**`, `src/app/(app)/messages/**` (Message Center: Inbox and Sent tabs, filter, mark read or unread, delete, New Message with a recipient picker for everyone, people by name, ranks, a job roster or coordinators, optional job link, reply)
- Test: `tests/e2e/personnel.spec.ts`

Content per mockup row D: Home (stat tiles for caps, Ready to bill card, Up next, Open for you with filters, Waiting on payment); Job page ("Alert me if it opens" toggle on full or unreleased jobs, facts, Officer Safety card shown above About when present (with "Added by <name>, <role>, <date>" and "Edited by" when changed, under the notes and under each address), Deputy notes section with an "Add a note for future deputies" button, with each address, its description, Open in Maps and a pin on a small map; About, Roster table, Staffing card, sign-up panel listing `checks` from `eligibilityFor`, warning acceptance dialog, Activity from audit); Calendar (day, week, month, list; personal `.ics` feed URL with a revocable token); Billing (to bill with the billing form, history with totals, chart and CSV export, Report non-payment); Earnings (this month, this year, outstanding, year by year, and a Tax summary per year with PDF and CSV download from `earningsDashboard` and `taxYearSummary`); Map (same filters as the list, "Only details I can work" respected); Sign-up dialog with a time picker limited to the flex range in 15-minute steps; Jobs list (sort control, "Only details I can work" toggle, "Hide this vendor" on each job); Home goal card (goal, earned, signed up, remaining) and a Recommendations list with Sign up buttons; Profile (calendar link with last-synced time and error, work schedule editor with weekly and rotation patterns, a preview of the next 4 weeks and one-off changes, earnings goal, hidden vendors list, contact, mailing address, W-9 upload, alert preferences, quiet hours, theme, push enable).

- [ ] **Step 1:** E2E: a deputy signs up after accepting the warning and sees the job on Home and Calendar; a capped deputy sees the exact cap message and a disabled button; billing with changed hours requires a reason; the `.ics` feed lists their details.
- [ ] **Step 2–4:** Run, implement, run.
- [ ] **Step 5:** Commit: `Add personnel screens`

### Task 38: Coordinator screens

**Files:**
- Create: `src/app/(app)/coordinate/**` (to-do, vendors, job editor with copy and recurrence, roster actions, invoice review, payment issues, ops plans, library)
- Test: `tests/e2e/coordinator.spec.ts`

A "Switch to training" toggle in the coordinator menu asks which role to practice as and calls `switchMode`; a "Back to live" button sits in the training banner. To-do list sections in this order (Deputy notes to review, Flag requests and Details missing a contract sit after Vendor requests; Access review, when one is open, sits at the top with its progress): Locked details started (vendor on payment hold; one-tap Cancel with the reason prefilled) and locked details starting within 24 hours, Vendor requests, Invoices to review, Payment issues waiting on the coordinator (with age), Ops plans (overdue, waiting for review), Unfilled jobs starting within 72 hours, Billing locks. A Payments view lists every unpaid invoice grouped by who is responsible (deputy, coordinator, vendor) with days waiting and the timeline. A Reports area lists the built-in and saved reports, a builder for `ReportSpec` (dataset, date range, filters, group by, measures), results table, and CSV or PDF export; a deputy picker opens any deputy's earnings dashboard and tax summary.

New detail form has a Dates step: tabs Range (from, to, optional weekday chips), Pick dates (multi-select month calendar), Repeat (pattern); a preview list with per-date time overrides and remove buttons; "Create N details".
- [ ] **Step 1:** E2E: create a detail on 6 clicked dates in one save and see 6 details in one series; create one for every day Dec 15 to Dec 31; edit the series rate and see the alert reach a signed-up deputy; approve a vendor request; approve a held invoice; send one back.
- [ ] **Step 2–4:** Run, implement, run.
- [ ] **Step 5:** Commit: `Add coordinator screens`

### Task 39: Admin screens

**Files:**
- Create: `src/app/(app)/admin/**` (users, ranks, suspensions, seasons, settings grouped as Release, Sign-up, Billing and invoices, Reminders and locks, Vendors, Ops plans, Email (SMTP with a "Send test email" button), audit log)
- Test: `tests/e2e/admin.spec.ts`

Two areas: Management (users, ranks, suspensions, seasons and caps, release, minimum hours, warning, job types, payment methods, vendor limits, reminders and locks, billing reply address, invoice prefix, ops plan reviewers, audit log; coordinators and admins) and System (SMTP with "Send test email", security settings; admins only).

- [ ] **Step 1:** E2E: a coordinator invites a user, suspends one with an end date, changes the release day to 20 and sees a scheduled job's release date move, and edits the All year season's week cap; an admin's SMTP test email reaches the test transport; coordinators get 403 on every System URL.
- [ ] **Step 2–4:** Run, implement, run.
- [ ] **Step 5:** Commit: `Add admin screens`

### Task 40: Vendor portal screens

**Files:**
- Create: `src/app/(vendor)/**` (details list and calendar, new request, detail page with allowed edits and cancel, invoices)
- Test: `tests/e2e/vendor.spec.ts`

- [ ] **Step 1:** E2E: a vendor submits a request, a coordinator approves it, the vendor sees it scheduled, sees assigned names once filled, cannot edit within 24 h, sees the sent invoice and marks it paid by Ramp with a reference, which the deputy then sees as "Vendor reports paid"; a vendor URL for another vendor's job returns 404.
- [ ] **Step 2–4:** Run, implement, run.
- [ ] **Step 5:** Commit: `Add vendor portal screens`

## Phase 6: API, end to end, deployment

### Task 41: REST API, API keys and full data access

**Files:**
- Create: `src/app/api/v1/openapi.json/route.ts`, `src/app/(app)/admin/api/page.tsx` (API docs viewer and key management), `src/lib/api/registry.ts`, `src/lib/api/handler.ts`, `src/domain/api-keys/api-keys.ts`, `src/domain/export/export.ts`, `src/app/api/v1/data/[entity]/route.ts`, `src/app/api/v1/export/route.ts`
- Modify: `src/db/schema/auth.ts` (add `api_keys` (name, hashedKey, prefix, scopes text[], createdBy, lastUsedAt, expiresAt nullable, revokedAt))
- Test: `tests/integration/api/contract.test.ts`, `tests/integration/api/api-keys.test.ts`, `tests/integration/api/data.test.ts`

**Interfaces:**
- Produces:
  - `createApiKey(actor, tx, { name; scopes: Array<'read' | 'write' | 'w9'>; expiresAt?: Date }): Promise<{ key: string }>` (admin only; the full key is shown once and stored only as a hash; `w9` lets a key download W-9 files and is off unless chosen), `revokeApiKey`, `listApiKeys`; every key request is audited with the key name and rate-limited to 600 requests per minute
  - `GET /api/v1/data/{entity}` for every table except auth secrets (`users`, `vendors`, `jobs`, `job_positions`, `assignments`, `invoices`, `invoice_events`, `payment_issues`, `ops_plans`, `audit_log`, and the rest), with `updatedSince`, cursor paging and filters; read scope
  - `GET /api/v1/export?format=json|csv` (read scope; a zip of every table, streamed; W-9 and other files listed by id, not included)
  - Write scope uses the same domain-service routes as the app, so every rule and audit applies to API writes too
  - `apiHandler(schema: { body?: ZodType; query?: ZodType; response: ZodType }, fn)` (auth via session cookie, `Authorization: Bearer` session token for the future native app, or `Authorization: Bearer ed_live_...` API key; maps `ForbiddenError` 403, `NotFoundError` 404, `ValidationError` 400, `RuleViolation` 409 with `checks`, `UnauthenticatedError` 401), OpenAPI document at `/api/v1/openapi.json`.

- [ ] **Step 1:** Tests: every `route.ts` under `src/app/api/v1` is registered in the OpenAPI document (file scan); a `RuleViolation` returns 409 with the checks array; a bearer token works for `GET /api/v1/jobs`; a coordinator cannot create an API key; a read key can call `GET /api/v1/data/invoices?updatedSince=` but gets 403 on a write route; a revoked key gets 401; a key without `w9` gets 403 on W-9 download; the export zip contains one file per table and no password hashes or tokens; API keys always read and write live data, never training mode.
- [ ] **Step 2–4:** Run, implement (retrofit earlier routes onto `apiHandler`), run.
- [ ] **Step 5:** Commit: `Add REST API, API keys and full data export`

### Task 42: End-to-end flows

**Files:**
- Create: `tests/e2e/flows/*.spec.ts`, `tests/e2e/fixtures.ts` (clock control, seeded agency)
- Test: the files themselves

- [ ] **Step 1:** Flows: (a) vendor request to approval to release at the 15th 4:00 PM to sign-up to billing to invoice email with W-9 to mark paid to job Closed; (b) cancel to backup window to backup claims; (c) unbilled lock blocks sign-up until billing; (d) ops plan required, IC submits, reviewer denies, IC resubmits, reviewer agrees, plan appears in the library; (e) non-payment report to coordinator note to paid.
- [ ] **Step 2:** Run `npm run test:e2e -- --trace off`. Expected: all pass.
- [ ] **Step 3:** Commit: `Add end-to-end flow tests`

### Task 43: Deployment, training mode, staging and production

**Files:**
- Create: `src/lib/env.ts` (`APP_ENV`: `production` or `staging`; staging is where new versions are checked first and runs on demo data with the outbox), `src/domain/training/mode.ts` (`type DataMode = 'live' | 'training'`; the session stores `mode` and `practiceRole`, default `live` on every new sign-in; `switchMode(actor, mode, practiceRole?)` for coordinators and admins only; `dbFor(mode)` and `storageFor(mode)` return the live or training connection (`TRAINING_DATABASE_URL`, `TRAINING_BUCKET`), and every service receives its `Tx` from `dbFor(session.mode)` in one request wrapper, never choosing a database itself; in training the actor is the demo user for `practiceRole`), `src/domain/training/reset.ts` (`resetTrainingData(actor, tx)`: coordinators, training database only; wipes and reloads `src/db/demo-seed.ts`), `src/db/demo-seed.ts` (`buildDemoData(today: Date)`: a made-up agency with about 20 vendors, about 30 deputies across all ranks and a dispatcher, coordinators and an admin; dates are generated relative to `today`: 12 past months with worked, billed, paid, overdue, written-off, late-cancelled, no-show and payment-issue examples and agreed ops plans, the current month in every job and invoice state, and 3 future months with scheduled, open, filled, backup, pending-shorter, flexible-time, officer-safety and vendor-on-hold details), `src/jobs/training-reset.ts` (nightly at 2:00 AM agency time, on by default), workers run their ticks against both databases, training banner ("TRAINING: practicing as <role>") in the app shell and every PDF while in training mode, email outbox in `EmailSender` (in training mode or on staging nothing is sent; every message is stored in `training_outbox` and shown on an Outbox page to coordinators), `Dockerfile` (multi-stage, runs web or worker by `ROLE` env), `docker-compose.yml` (web, worker, postgres, minio for local), `src/app/api/health/route.ts`, `docs/operations.md` (environment variables, backups, key rotation for `FILE_MASTER_KEY`, restore steps)
- Test: `tests/integration/health.test.ts`

- [ ] **Step 1:** Tests: `/api/health` returns 200 with database, queue and `APP_ENV`, 503 when the database is down; in training mode or on staging no SMTP connection is ever opened and an invoice email appears in the Outbox with its recipients and attachments; `resetTrainingData` is refused on the live database and by personnel; a new sign-in is always `live`; personnel calling `switchMode` get `ForbiddenError`; after `switchMode('training', 'deputy')` creating a job, signing up and billing write only to the training database and storage (live row counts unchanged), and after switching back to live the same actions write only to live (training counts unchanged); a request whose session mode changes mid-request uses the mode at the start; after a reset the demo counts match the seed; `buildDemoData` run for any date has at least 10 details in each of the 12 past months, the current month and the next 3 months, and every job, assignment and invoice state is present; every page shows the training banner in training mode and invoice PDFs carry "TRAINING". `docs/operations.md` documents two deployments (production, which includes training mode with its own database and bucket, and staging) from the same image, and the release path: deploy to staging, check, then production.
- [ ] **Step 2–4:** Run, implement, run; `docker compose up` starts web and worker and runs migrations once.
- [ ] **Step 5:** Commit: `Add container build, health check and operations guide`

---

### Task 44: User manuals with screenshots

**Files:**
- Create: `docs/manuals/deputy/*.md`, `docs/manuals/coordinator-admin/*.md`, `docs/manuals/vendor/*.md`, `scripts/capture-screenshots.ts` (Playwright against staging's demo data, or production in training mode: switches to each practice role (deputy, coordinator, admin, vendor), walks each documented task, and saves numbered screenshots at phone and desktop sizes in day theme into `docs/manuals/images/`), `scripts/build-manuals.ts` (Markdown to PDF with the agency header and to in-app Help pages), `src/app/(app)/help/[[...slug]]/page.tsx`
- Test: `tests/e2e/manuals.spec.ts`

Contents, one chapter per task with numbered steps and a screenshot per step:
- Deputy: signing in and two-factor, profile and W-9, mailing address, work schedule and calendar link, hidden vendors, finding and sorting details, map, signing up (positions, flexible and shorter times, backups), cancelling, billing a detail and changing hours, marking paid, reporting non-payment, locks and how to clear them, earnings dashboard and tax summary, ops plans as Incident Commander, alerts and theme.
- Coordinator and admin: everything above plus vendors, contracts, locations and pins, payment holds, creating details (positions, flexible times, officer safety, copies and recurrence), vendor requests, assigning and removing, no shows and suspensions, invoice review, payment responsibility and issues, ops plan review and library, reports and exports, settings (each section), users and ranks, switching to training mode and resetting it, API keys (admin), SMTP and security (admin).
- Vendor: signing in, requesting a detail, flexible times and officer safety, editing and cancelling within the limits, invoices and marking paid.

- [ ] **Step 1:** Test: every manual image referenced exists; every Help page renders; the build produces three PDFs; screenshots contain no real data (capture refuses to run against live data (staging, or a session in training mode, only)).
- [ ] **Step 2–4:** Run (FAIL), write manuals and scripts, run (PASS); rerun `capture-screenshots` on every release so pictures match the app.
- [ ] **Step 5:** Commit: `Add deputy, coordinator and vendor manuals with screenshots`

## Spec coverage check

| Spec section | Tasks |
|---|---|
| 1 Intent, success | 21–23 (no manual invoices), 27 (automatic openings), 35 (phone), 31 (no vendor contact) |
| 3 Constraints | 2 (time zone), 3, 9, 11 (no deletes), 41 (portable hosting) |
| 5 Technology | 1, 3, 6, 10, 23, 26, 39 |
| 6 Roles, ranks | 5, 7, 8 |
| 7 Accounts | 6, 9 |
| 8 Vendors, portal, vendor settings | 11, 29, 40 |
| 9 Jobs, IC, creation, release, statuses | 13, 14, 15, 18 |
| 10 Sign-up, caps, backups, coordinator actions, locks, personal planning | 16–19, 30, 35 |
| 11 Ops plans, review, library | 32, 33 |
| 12 Billing, invoices, review, earnings, reports, issues | 20–25, 31, 34 |
| 13 Security | 6, 7, 10, 5 |
| 14 Alerts, messages | 26–28 |
| 15 Screens, look | 36–40 |
| 16 Admin settings | 4, 39 |
| 3a Environments | 43 |
| API and data access, manuals | 41, 44 |
| 17 Build order | phase order of this plan |

## Defaults to confirm (from the spec's open questions)

These are settings, so the build does not wait on them. Each needs the owner's answer before launch.

Decided since the first draft: invoices show the deputy's name, mailing address and email (payment information only; questions and disputes go to coordinators); minimum billable time 4 hours, overridable per vendor, job and invoice; self-cancel allowed until the detail starts; 16 hours maximum in any rolling 24 hours; coordinators can do everything except change the email server and security settings; payment methods list includes Ramp and Bill.com; vendors can mark paid on their side; every unpaid invoice is the responsibility of the deputy, coordinator or vendor until both deputy and vendor mark it paid, with a full timeline; notes on payment steps are optional with coordinator-managed default notes; a deputy must confirm a vendor-reported payment within 30 days (setting) or sign-ups lock, with an "all invoices" mode for later; late vendor cancellation inside 24 hours is paid unless a coordinator waives it.

Late cancellation pays the 4-hour minimum (`lateCancelPayBasis` `minimum`). Also decided: 15-minute billing increments; backup offers one at a time, to all backups, or to everyone, with a 30-minute default window; coordinators may assign over caps with a reason; vendors see full names; vendors use emailed two-factor codes; ops plans due 72 hours before by default; details are built from positions (default Deputy Sheriff); seasonal caps per agency; receipts for paid-on-the-spot invoices; Revised invoices keep their number; users choose their theme and alerts.

1. Weekly and monthly limits: values entered at setup; planned as calendar weeks and months.
