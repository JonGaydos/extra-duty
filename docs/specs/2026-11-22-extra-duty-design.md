# Extra Duty: Off-Duty Detail Scheduling App, Design

> Summary: an off-duty detail system that a sheriff's office runs for
> itself. Vendors request details, deputies sign up first come,
> first served under rank, hour-cap and billing rules, and after the detail
> the deputy bills the vendor directly through an emailed PDF invoice. The
> agency never touches money. TypeScript web app (Next.js, PostgreSQL),
> mobile web first, API-first for a later native app. "Extra Duty" is a
> working name.

Date: 2026-11-22. Status: draft for review.

Items marked **[Proposed]** were suggested during design and not
explicitly confirmed by the owner. Everything else was decided by the
owner. Items marked **[Builder]** are left to the builder.

---

## 1. Intent

The Sheriff's Office runs off-duty details on a self-contained model: it
runs its own system, and vendors pay deputies directly.

The app must cover the whole detail workflow (vendors, posting, sign-up,
billing and payment tracking), remove the manual work coordinators do
around it (sending invoices by hand, announcing openings and rate changes
by message), and look modern.

### Success looks like

- Coordinators no longer send invoices or announce openings by hand.
- Deputies can do everything (find, sign up, cancel, bill, track payment)
  from a phone.
- A deputy never has to talk to a vendor about payment.

### Timeline and data

- No deadline.
- The app starts fresh. No data is migrated.

## 2. Goals, non-goals, anti-goals

**Goals**
- Vendor management, including a vendor portal for requesting details.
- Job posting with scheduled monthly release, rank eligibility, Incident
  Commander slots, attachments, and recurring or copied jobs.
- First come, first served sign-up enforced by rules: rank, hour caps by
  season, overlaps, suspension, and unbilled-detail lock.
- Backups and cancellation handling.
- Billing: hours reporting, invoice PDF, optional W-9 attachment, email via
  SMTP, payment tracking, payment issue escalation.
- Ops plans with review and a reusable library.
- Alerts by in-app inbox, email and phone push.
- Day and night themes. Mobile web that installs to the home screen.

**Non-goals (first version)**
- Taking or processing payments (cards, ACH, payment processors).
- Estimates, prepayment, fees, billing cycles, grouped invoices.
- Manual approval of applications (the agency uses first come, first
  served).
- Text messages via email-to-text gateways.
- Single sign-on or Active Directory (the owner does not want AD).
- Native iPhone and Android apps (planned later; the API must support them).
- Migrating data from an earlier system.

**Anti-goals (would be a failure even if it works)**
- The agency holding, routing or reconciling detail money.
- Deputies contacting vendors about payment.
- Exposing Social Security numbers beyond the deputy, coordinators and
  admins.
- Per-user licensing or a platform that charges by headcount.

## 3. Constraints

- Cloud hosted. Provider not chosen yet. Must be portable (container plus
  PostgreSQL plus S3-compatible storage) so it can move to AWS or Azure
  if county IT requires.
- County IT approval is not required; IT will give input on hosting.
- Email goes out from an app address on the agency domain (for example
  noreply@<agency domain>, with SPF and DKIM records), and replies go to
  the coordinator billing address.
- Florida public records law (Chapter 119) applies to agency records.
  Records are deactivated, never hard-deleted, and exports must be
  possible. SSNs on W-9s are exempt from disclosure and must be protected.
  Everything is kept by default.
- No criminal justice information is stored, so CJIS is assumed not to
  apply (assumption to confirm with county IT).
- Time zone: America/Chicago (the agency is on Central Time). All rules
  (release time, caps, billing unlock) run in agency local time.
- Scale today: about 270 details a month (20 to 26 on Sundays), roughly 100
  active vendors, at least 200 users. Small for any host.
- Hosting budget roughly $25 to $75 a month.
- Coordinators and admins manage the hosting account and its billing.
  Who maintains the code after it is built is not decided.

## 3a. Environments

- **Production**: the live site with real users, vendors and money
  records.
- **Training mode (demo)**: part of the live website, not a separate
  site. Coordinators and admins sign in normally and flip a "Switch to
  training" toggle, choosing which role to practice as (deputy,
  coordinator, admin or vendor). Deputies do not get the toggle.
  - Training has its own database and file storage, filled with made-up
    vendors, deputies and details, so nothing done in training touches
    live data. Its database lives in the same managed database server as
    production at no extra cost.
  - Guardrails: live is always the default and each new sign-in starts in
    live; a permanent colored "TRAINING" banner on every page and every
    PDF; the mode is checked on every save; automated tests prove
    training actions never reach the live database or storage, and live
    actions never reach training.
  - No email ever leaves training mode. Everything it would have sent is
    kept in an in-app outbox page coordinators can read.
  - A coordinator can reset training to the starting demo data at any
    time, and it resets automatically every night.
  - The demo data is generated relative to today, so there is always
    something for every month: the past 12 months (details worked,
    billed, paid, late, written off, cancellations, no shows, payment
    issues, ops plans), the current month in every state, and the next 3
    months (scheduled, open, filled, pending shorter sign-ups, backups,
    a vendor on payment hold, flexible-time and officer-safety details).
- **Staging**: a separate copy used only to check new versions of the app
  before they reach production. It uses the same made-up data and in-app
  outbox. New versions go to staging, are checked, then go to production
  (which carries training mode with it). Estimated hosting about $61 a
  month for production, training mode and staging.

## 4. Approaches considered

| Approach | Trade-off | Outcome |
|---|---|---|
| **TypeScript: Next.js plus PostgreSQL, API-first** | Modern, fully custom UI; same language and types as a future React Native app; more pieces to assemble (auth, jobs, admin screens) | **Chosen.** Owner wants a fresh look, mobile web now and a possible native app later |
| Python Django plus PostgreSQL | Sign-in, admin, email and scheduled tasks built in; rules in one place | Rejected: harder to deliver the modern UI and to share code with a native app |
| Supabase (hosted DB, auth, storage) plus a web front end | Fastest start, two-factor and storage included | Rejected: security lives in database row policies that are hard to get right for vendor and W-9 permissions; provider lock-in |
| Low-code (Power Apps, Retool) | Quick admin screens | Excluded: per-user licensing for hundreds of users, rules outgrow it |
| Existing open-source scheduler | Nothing to build | Excluded: none fit the off-duty detail model |

## 5. Technology

Decided: TypeScript throughout, Next.js web app, PostgreSQL, API-first,
cloud hosted, mobile web (installable PWA), future native app.

| Part | Choice |
|---|---|
| Web app | Next.js (App Router), React, TypeScript |
| Styling | Tailwind CSS with design tokens for day and night themes **[Builder]** |
| API | Versioned REST API (`/api/v1`) with an OpenAPI description, used by the web app and the future native app. Business rules live in a domain layer that does not depend on Next.js |
| Database | PostgreSQL. ORM: Prisma or Drizzle **[Builder]** |
| Sign-in | Better Auth or equivalent: email and password, emailed 6-digit code as the second factor, session management **[Builder]** |
| Background jobs | Postgres-backed queue (for example pg-boss) for release timing, reminders, emails, push **[Builder]** |
| Email | Provider chosen in admin settings: an email delivery service over its web API (Postmark, Amazon SES, SendGrid or Mailgun; service not yet chosen) or an SMTP server. DigitalOcean blocks common SMTP ports on its servers, so an API service is the expected choice there; SMTP stays available for other hosts. Sends from noreply@<agency domain> with SPF and DKIM |
| PDFs | Server-side invoice PDF generation **[Builder]** |
| Files | S3-compatible object storage, encrypted at rest. W-9 files additionally encrypted by the app (see 13) |
| Push | Web Push (VAPID) for the installed web app |
| Hosting | DigitalOcean (decided): App Platform for the web app and worker, Managed PostgreSQL, Spaces for files. Production (with training mode) plus staging, about $61 a month. Portable to AWS or Azure later if ever required |
| Tests | Unit tests for the rules engine (release, caps, eligibility, locks, billing states); end-to-end tests for main flows **[Builder]** |

## 6. Users and roles

| Role | Can do |
|---|---|
| **Vendor** | Log in to the vendor portal; request details; view and edit their own details within admin limits; see invoices sent to them (read only) |
| **Personnel** (Deputy Sheriff, CSO, Posse, Dispatcher) | Find and sign up for details; join as backup; cancel; bill; track payments; report non-payment; manage profile and W-9; submit ops plans when acting as Incident Commander |
| **Coordinator** | Everything Personnel can, plus manage vendors and jobs, approve vendor requests, assign and remove people, mark no shows, review and send invoices, handle payment issues, see W-9s, override billing locks, manage users, ranks and suspensions, waive late cancellation pay, read the audit log, change all settings except email server and security |
| **Admin** | Everything a Coordinator can, plus the email server (SMTP) and security settings |

- Coordinators and admins have nearly the same permissions. Coordinators
  can change the detail rules settings (seasons and hour caps, release
  schedule, minimum billable hours, warning text, job types, vendor
  limits, reminder and lock settings, payment methods).
- Coordinators also manage users and ranks, suspend accounts, waive late
  vendor cancellation pay, and read the audit log.
- Admin only: the email server (SMTP) and security settings (two-factor
  policy, trusted device length, password rules).
- Coordinators and admins can see deputies' W-9s.
- Ops plan reviewers are people named in settings (see 11). Being a
  reviewer is a setting, not a role.
- Coordinators also work details as Personnel.
- Limiting coordinators to specific vendors is not needed.

### Ranks

Ladder, lowest to highest: **Posse, CSO, Deputy Sheriff**. There are no
Sergeant or Lieutenant ranks; supervisory and special roles are flags
(below). A higher rank can fill a lower rank's spot (a Deputy can
take a CSO spot, a CSO can take a Posse spot). Dispatcher is a separate
class outside the ladder. Coordinators and admins can add ranks or
classes (for example Captain) and reorder them.

### Positions

- A detail is made of positions. Each position has a type, a count, and
  the ranks that can fill it.
- Coordinators and admins manage position types, each with its eligible
  ranks ("X and higher" is a shortcut) and required flags. Main types:
  Dispatcher, Incident Commander and Deputy Sheriff; also CSO and Posse.
  Defaults: Posse spot: Posse and higher; CSO spot: CSO and higher; Deputy
  Sheriff spot: Deputy Sheriff; Incident Commander: anyone with the
  Incident Commander flag; Dispatcher: Dispatcher only. Coordinators can
  add types such as "School Resource Deputy" (Deputy Sheriff with the SRO
  flag).

### Special flags (qualifications)

- There is one Deputy Sheriff rank. Specialties are flags on the person,
  not ranks: for example School Resource Deputy, K9, Motors, Incident
  Commander. Coordinators and admins create flags and give them to people
  in user management (who granted it and when is recorded).
- A position can require one or more flags on top of its rank rule, for
  example "Deputy Sheriff and higher, with the School Resource Deputy
  flag". A detail can change a position's required flags.
- Requesting a flagged position on a detail:
  - Coordinators pick it in the positions list of the detail form, either
    as a ready-made position type (for example "School Resource Deputy",
    which requires the SRO flag) or by adding required flags to any
    position. The form shows how many active people hold each flag.
  - Vendors pick from the position types coordinators have marked as
    requestable, by name (for example "Deputy Sheriff" or "School
    Resource Deputy"). By default every position type is requestable,
    including Incident Commander and Dispatcher. They see the position
    name only, never who holds which flag.
  - Coordinators can change the positions or flags when approving a
    vendor's request. Only people with the flag can sign up for that
    position.
- Incident Commander eligibility is the Incident Commander flag alone,
  whatever the person's rank.
- Each person sees their own flags in their profile, coordinators see
  everyone's, and vendors never see them.
- When a coordinator or admin adds a person, the Add user form includes
  their flags, so known qualifications are set from day one with no
  request needed.
- On their first sign-in, the welcome steps (password,
  mailing address, W-9) also show the flag list so a new deputy can
  request any the coordinator missed.
- A person can request a flag from their profile (with an optional
  note). The request goes to the coordinators' to-do list; a coordinator
  approves or denies it with an optional reason, and the person is
  alerted. Requests and decisions are logged. If the agency wants supervisor-only spots,
  coordinators can create Sergeant or Lieutenant flags.
- When adding a detail, the vendor or coordinator picks the positions.
  By default every spot is the default position type, Deputy Sheriff (a
  setting coordinators and admins can change).
- Example: 17 spots = 1 Dispatcher, 1 Incident Commander, 14 Deputy
  Sheriff, 1 CSO. Personnel requested is the total of all positions.
- A detail can override a position's eligible ranks.
- People sign up for a specific position they are eligible for, and
  backups are kept per position.

## 7. Accounts and sign-in

- No Active Directory. The app has its own accounts.
- A coordinator or admin creates each account (name, email, phone, rank,
  ID or badge number). The person gets an email invite and sets a
  password.
- Two-factor sign-in required for everyone, vendors included, because
  W-9s with SSNs are stored. The only second factor is a 6-digit code
  emailed to the user at sign-in (no authenticator apps). Codes expire
  after 15 minutes and allow 5 tries (settings). Trusted
  phones stay signed in for 30 days.
- On the staging site, which sends no email, the code is shown on screen
  instead. (Training mode needs no code of its own: people are already
  signed in to the live site.)
- Password reset by email; coordinators and admins can force a reset or
  disable an account.
- People who leave are deactivated, never deleted. History stays.
- Inactivity lock: an account with no sign-in for 3 months (a setting)
  is locked. At the sign-in screen the person unlocks it themselves by
  resetting their password through an emailed link plus the emailed
  6-digit code, without a coordinator. Applies to vendor logins too.
  The sign-in screen shows this next to the "Forgot password?" link:
  "Accounts not signed in within the past 3 months require a password
  reset." (The period follows the setting.)
  Self-unlock works at any time, however long the account was inactive.
  Former employees are handled by deactivating them when they leave and
  by the annual access review (decided; known gap: someone who still
  reads the account's email could unlock it until they are deactivated).
- Annual access review: once a year (date and frequency are settings),
  coordinators get an access review on their to-do list listing every
  active account with role, rank, flags and last sign-in. Each account is
  marked Keep, Change (flags or role) or Deactivate. Reminders continue
  until every account is reviewed. The finished review is saved with who
  reviewed what and when, and is available as a report.
- Vendor accounts: a coordinator creates the vendor and its logins after
  the vendor is approved (the contract can follow later). A vendor can have
  several logins.

## 8. Vendors

### Vendor record

- Name, type (for example Church, HOA, Retail, Event), contact name, phone,
  billing email(s), notes.
- Contracts: every vendor needs one. The vendor record holds contract
  documents as uploaded files (PDF) and as links (for example to a
  signing service or shared drive), each with a label, signed date and
  optional expiration date. Every detail must be covered by a contract:
  either one contract for the vendor (covering its details while it is
  current) or a contract attached to the detail itself, which is the
  usual case. The contract is optional when adding a vendor or a detail,
  so an urgent detail can be entered right away. A detail with no vendor
  contract and no detail contract shows "Contract missing" (coordinators
  only) and stays on the coordinators' to-do list until one is added.
  Vendors can attach a detail's contract when they request it. A missing
  contract never blocks anything: the detail can be posted, worked and
  billed. Coordinators get reminders 60 and 30 days before
  a contract expires. Contract documents are visible to
  coordinators, admins and that vendor.
- Locations: one vendor, several sites (for example a school district's
  schools, or a landscaping company's job sites), each with a name,
  address, map pin and site notes. Vendors add and edit their own
  locations in the portal, including while adding a detail; coordinators
  can add, correct the pin, or deactivate. A location used by past
  details is deactivated, never deleted.
- Default rate (used when creating jobs for that vendor).
- Payment issue history (see 12.7) and payment hold (12.7a).
- Active or inactive.

### Vendor portal

- **New requests:** date, time, location (pick one of theirs or add a
  new one on the spot), positions, type,
  description, attachments. A request goes to the coordinators, who
  approve it (with or without edits) or decline it with a reason.
  Approval publishes it under the normal release rules.
- **Edits to approved details** are allowed only within admin settings.
  Changes to time, date or headcount go back to a coordinator. People
  already signed up are alerted when the change is approved.
- Vendors see the full names of assigned personnel once the detail is
  filled. They never see contact
  details, the roster of other jobs, or other vendors.
- Vendors see their invoices and payment status, and can mark invoices
  paid on their side (12.8).

### Vendor settings (coordinators and admins, each adjustable)

| Setting | Example default |
|---|---|
| Minimum notice for new requests | 72 hours before start |
| Edit lock window | No changes within 24 hours of start |
| Edits once someone is signed up | Not allowed, or only adding positions |
| Vendor cancellation allowed until | X hours before start (inside the late window, cancellation is still allowed but late cancellation pay applies, 12.9) |
| Vendor can set the rate | No, coordinator sets it |
| Edits need re-approval | Yes, for time, date and headcount |
| Vendor sees assigned names | Yes (full names), once filled |

## 9. Jobs (details)

### Fields

- Job number (sequential), vendor, location and address, title, description
  (free text, can be long: point of contact, check-in, conduct rules,
  policy warnings), notes.
- Start and end date and time (may cross midnight).
- Flexible times (optional, set by the vendor or coordinator when adding
  the detail): the earliest allowed start and latest allowed finish. The
  default times stay as requested. A deputy can pick their own start and
  finish inside that range, for example a 5:00 PM to 11:00 PM detail with
  a range of 5:00 PM to 12:00 AM lets a deputy work 5:45 PM to 11:45 PM,
  but nobody can move it to 9:00 PM to 3:00 AM. The vendor can also allow
  shorter shifts (for example 6:00 PM to 11:00 PM on a 6-hour detail);
  otherwise the deputy's hours equal the default length. Shorter shifts
  still bill at least the minimum billable time. So a shorter sign-up
  never takes a spot from someone willing to work the full length, a
  shorter sign-up made early is **pending**: it does not hold a spot, and
  anyone signing up for the full length gets the spot first. When the
  window opens (default 24 hours before the start, set by coordinators
  and admins), pending shorter sign-ups are confirmed in the order they
  were made while spots remain open, after rechecking caps and overlaps;
  the rest are declined. Everyone is alerted either way. Inside the window
  a shorter sign-up for an open spot is confirmed at once. Coordinators
  see pending sign-ups on the job; the vendor sees only confirmed ones. Shifting the same length inside
  the range (5:45 PM to 11:45 PM) is allowed any time. The range itself is
  the vendor's permission, so no separate approval is needed. The deputy sets their times when signing up and can
  change them until the detail starts. Caps, overlaps, schedule fit,
  billing and the vendor's view all use each deputy's own times.
- Type, from an admin-managed list (for example Basic Security, Traffic
  Control, County Permitted Event).
- Rate per hour, set per job (defaults from vendor, then agency default).
  Coordinators can change it after posting. A rate change alerts the people
  already signed up or on backup.
- Positions: types and counts (see 6), which add up to the personnel
  requested.
- Ops plan required (yes or no) and due date (see 11).
- Officer safety (optional, its own section, not mixed into the notes):
  safety notes plus one or more addresses of concern, each with a short
  description. Example: a power line clearing company working near 123
  Main St, Pine Harbor, FL. Deputies can research the address before the
  detail; each address has an "Open in Maps" link and a pin on the job's
  map. The vendor can fill it in when requesting the detail, and
  coordinators can add to or edit it.
  - Every safety note and address shows who added it and when (for
    example "Added by Quinn Okafor, coordinator, Nov 20, 2026" or "Added
    by Coastal Line Clearing (vendor), Nov 18, 2026"), and "Edited by ...,
    date" when changed. Earlier versions stay in the job's history.
  - Visible to all personnel who can see the job and to that vendor;
    never on invoices or vendor emails. Changes are logged and
    alert everyone signed up or on backup.
- Attachments and links (policies, maps, ops plans). A file or link can be
  marked as this detail's contract; contracts are shown to coordinators
  and the vendor, not to deputies.
- Vendor contact for the day (name, phone).
- Manual hold: a coordinator can hold a job so it does not release.

### Incident Commander

- Incident Commander is a position type marked as IC. Only people with
  the Incident Commander flag can fill it.
- The IC position counts as one of the personnel requested.
- If a coordinator requires an ops plan, the job must have an IC: either
  through an IC position or by the coordinator naming someone on the
  roster as IC.

### Creating jobs

- Coordinators create jobs directly. Vendors request them through the
  portal (approval needed).
- Bulk dates (a main coordinator time saver): when adding a detail, the
  coordinator fills in the details once (vendor, location, times,
  description, positions, rate, flexible times, officer safety,
  attachments) and then picks the dates:
  - a date range, such as every day through the end of the month,
    optionally only certain weekdays;
  - specific dates clicked on a calendar, such as the 1st, 12th, 19th,
    20th, 21st and 30th;
  - or a repeating pattern (daily, weekly, monthly) with an end date or
    count.
  A preview lists every date before saving; any date can be removed or
  given different times. One save creates all of them (up to 366) as one
  series. **[Proposed]** Vendors get the same date picker when requesting
  details, and the coordinator approves the whole set at once.
- Copy an existing detail to new dates the same way.
- Jobs created by copy or recurrence form a series. Edits can apply to one
  job or the rest of the series, and personnel are alerted.

### Release schedule

- Admin setting: details for a month open on a set day and time of the
  previous month. Currently the 15th at 4:00 PM for the following month.
  Day and time are settings because the agency has changed them before.
- A detail in the current month, or in next month once the release time
  has passed, is open as soon as it is posted.
- Details further out wait for their month's release.
- Held jobs do not release until a coordinator releases them.
- No alerts go out when details release, are posted or reopen to
  everyone; deputies check the app. Backups still get their turn offers
  (10.4).

### Job statuses

| Status | Meaning |
|---|---|
| Requested | Vendor request waiting for coordinator approval |
| Scheduled | Approved, waiting for its release time or held |
| Open | Taking sign-ups |
| Filled | All positions taken; backups can join |
| Ready to bill | End time passed; assigned personnel can bill |
| Billed | Everyone assigned has billed |
| Closed | Every invoice on the job is paid (deputy and vendor agree) or closed by a coordinator |
| Expired | Start time passed with positions unfilled (stays visible to everyone, marked Expired) |
| Canceled | Canceled by coordinator or vendor |
| On hold | Vendor is on payment hold (12.7a); closed to sign-ups until resolved |

### Assignment statuses (per person on a job)

Signed up, Backup (with position number), Canceled (by the person),
Removed (by a coordinator, with comment), No show, Ready to bill, Billed
(pending review or sent), Paid.

## 10. Sign-up and rules

### 10.1 First come, first served

- Eligible personnel sign themselves up while a job is open.
- Every sign-up requires accepting the agency warning (admin-editable
  text). The app records who accepted which version and when.
- The detail then appears on the person's calendar and job list.

### 10.2 Eligibility checks (all must pass)

1. Rank is eligible for the position being signed up for, and the
   person holds every flag the position requires.
2. Account is active and not suspended, and the person is not
   restricted from this vendor (10.5).
3. No billing lock (10.6) or payment acknowledgment lock (10.7).
4. No overlap with another detail the person is on.
5. Hour caps (10.3) are not exceeded including this detail.

The job page shows each check and the result, so a person always sees why
they can or cannot sign up.

### 10.3 Hour caps and seasons

- Maximum hours in any rolling 24-hour period, per calendar week and per
  calendar month. The 24-hour cap is rolling, not per calendar day: no
  24-hour window may exceed it, so overnight details need no special rule.
  The limit is customizable. The owner's agency: 16 hours in any rolling
  24 hours.
- Week and month limits are set by coordinators or admins (current weekly
  value to be entered at setup). They are calendar weeks (Sunday to Saturday)
  and calendar months. Any cap left blank is not enforced.
- Caps change with the time of year (for example looser over spring
  break, tighter in winter to share the load). Coordinators and admins
  define seasons, each with a date range and its own three caps. The
  season is chosen by the date of the detail.
- Which hours count is an agency setting: detail hours only (default),
  or details plus the on-duty shifts from each deputy's own work schedule.
  When on, the schedule is used only for the calculation and stays
  private.
- Weeks run Sunday to Saturday (a setting).
- Coordinators can assign someone over a cap with a logged reason.

### 10.4 Backups and cancellation

- When a job is filled, eligible personnel can join as backups, in order.
- A person who cancels stays on the job record as Canceled (unless an
  admin removes them) and the spot reopens.
- Watching: on any detail that is full or not yet released, a deputy can
  tap "Alert me if it opens" instead of joining the backup list. They get
  an alert when a spot opens to them: after the backups have had their
  turns, or at once when it is first come, first served (within 12 hours),
  and when a watched detail is released. Watching holds no place in line
  and can be turned off any time. A watch ends after its first alert (the deputy can watch again), when
  the deputy signs up, or when the detail starts.
- When a spot opens, backups get first chance. Coordinators choose how
  (setting): offered to backups one at a time in order, each with a window
  to accept (default 30 minutes) before it moves to the next; offered to
  all backups at once for the window; or opened to everyone immediately.
  When no backup accepts, the spot opens to everyone eligible.
- Default: one backup at a time in backup order, 30 minutes each, until
  every backup has had the chance, then open to everyone. When a spot
  opens within 12 hours of the detail's start (a setting), it skips the
  backup turns and is first come, first served for backups and everyone
  eligible; an offer chain still running at the 12-hour mark switches to
  first come, first served at that point.
- The record shows who canceled and who took the spot.
- Personnel can cancel themselves any time until the detail starts. After
  the start, only a coordinator can remove them.

### 10.5 Coordinator actions

- Assign a person directly (shows any failed checks; coordinator can
  override with a logged reason; optional alert to the person).
- Remove a person (comment required; the person is alerted).
- Mark a no show.
- Restrict a deputy from a vendor: a coordinator-only flag (not a vendor
  or deputy setting) that stops that deputy from signing up or joining as
  a backup for any of that vendor's details, with a required reason. Used
  when a vendor has an issue with a deputy. Lifting it is also
  coordinator-only. Both are logged.
  - The deputy no longer sees that vendor's details in
    lists, recommendations or alerts; opening one directly shows "Not
    available to you. Contact a coordinator." with no reason given. The
    vendor never sees the restriction.
  - A coordinator cannot assign a restricted deputy to that
    vendor without lifting the restriction first.
  - When the restriction is placed, the coordinator chooses
    whether to remove the deputy from that vendor's future details they
    are already on.
- Suspend: coordinators and admins, separate from the no show mark. A
  suspension has a reason and an optional end date and lifts
  automatically. A suspended person can still see and bill details they
  already worked. When suspending, the admin chooses whether to remove
  the person from future details.

### 10.6 Unbilled details: reminders and lock

- Admin settings: reminder frequency (daily, every other day, weekly),
  grace period after a detail ends before reminders start (for example 24
  hours), and lock on or off.
- The reminder email lists every unbilled detail with a link to billing.
- While any detail is past the grace period and unbilled, the person
  cannot sign up or join as a backup. The job page says why. The lock
  lifts as soon as the last one is billed. Details they are already on are
  not affected.
- "Handled" means billed. Unpaid invoices never lock anyone.
- Coordinators see who is locked and can override for one person with a
  logged reason.

### 10.7 Payment acknowledgment lock

- Coordinator settings: on or off, and which invoices it covers. The
  number of days is the deputy's response time (12.10).
  - **Vendor-reported payments** (first mode): once a vendor marks an
    invoice paid on their side, the deputy has their response time
    (default 30 days) to confirm it. Nothing locks during that time,
    which allows for a check taking a week or two to arrive.
  - **All invoices** (possible later mode): every sent invoice must be
    tracked as paid within that many days of being sent.
- The deputy clears an item by marking it paid or by reporting
  non-payment. An open payment issue counts as handled, so a deputy is
  never locked because a vendor has not paid (see 12.10).
- While any item is overdue, the deputy cannot sign up or join as a
  backup, with the same messages and coordinator override as 10.6.
- Reminders go out with the unbilled reminders, on the same schedule.

### 10.8 Personal planning (each deputy, private to them)

A deputy's personal settings (work schedule, calendar link and imported
busy times, earnings goal, hidden vendors, buffer, alert choices) are
private to that deputy. Coordinators and admins cannot see them.

**Work schedule**
- Each deputy can enter their primary duty schedule in their profile:
  - Weekly: chosen days and hours, for example Monday to Friday 8:00 AM
    to 5:00 PM, or 10:00 AM to 6:00 PM.
  - Rotation: a repeating cycle with a start date, for example the 2-2-3
    schedule (14-day cycle: on 2, off 2, on 3, off 2, on 2, off 3) with
    6:00 AM to 6:00 PM, 6:00 PM to 6:00 AM, or 10:00 AM to 10:00 PM
    shifts. Overnight shifts are supported.
  - One-off changes: extra shifts, swapped days, leave.
  - Calendar import: a deputy can paste a calendar link (an ICS link,
    which Outlook provides through "Publish calendar"). The app checks it
    once a day, plus a "Sync now" button, and treats busy events as times
    they cannot work. Busy times and event titles are kept so the deputy
    can see what conflicts (private to them); events marked Free are
    ignored; the link is stored
    encrypted and private. The agency's Microsoft 365 settings may block
    publishing calendars outside the organization; county IT would need
    to allow it.
- A travel buffer before and after each shift, chosen from none, 15, 30,
  45 minutes or 1 hour.
- A "Only details I can work" toggle hides details that overlap their
  schedule (with buffer). The schedule is a filter only; it never blocks a
  sign-up and does not count toward caps.

**Sorting**
- The job list sorts by date, vendor name, location, hourly rate or total
  pay, and filters as before.

**Earnings goal and recommendations**
- A deputy can set a monthly goal (for example $500).
- Home shows progress: earned, signed up for, and remaining to the goal
  this month.
- Recommendations: open details they are eligible for that fit their
  schedule, hour caps and existing sign-ups, chosen to reach the remaining
  goal. Ordered by start time, soonest first, with no overlaps. Each one
  has a Sign up button; nothing is reserved, so first come, first served
  still applies.

**Map view**
- A map of details (open, mine, or all I can see) using OpenStreetMap
  data, with the same filters as the list. Tapping a pin opens the job.
- Vendor locations are geocoded from their address when saved, and a
  coordinator can drag the pin to correct it.
- Map tiles from a hosted OpenStreetMap tile provider
  (free tier) rather than openstreetmap.org's own servers, whose usage
  policy does not allow an app's regular traffic.

**Hidden vendors**
- A deputy can mark a vendor "never show me". That vendor's details are
  hidden from their lists and recommendations, and they get no opening
  alerts for them. They can unhide any time from their profile.
- Hidden vendors are private: coordinators cannot see who has hidden which
  vendor. Coordinators can still assign them directly.

## 11. Ops plans

### On a job

- A coordinator can mark a job "Ops plan required" with a due date
  (default 72 hours before the detail; coordinators and admins can change the default and each job's due date).
- The Incident Commander submits the plan (PDF or Word upload). If the IC
  changes, the task moves to the new IC.
- If the IC is assigned after the due date, the plan is due before the
  detail starts.
- The plan shows on the job under Attached Files, marked "Ops plan".

### Review

- An admin or coordinator setting names one or more people responsible for
  reviewing ops plans.
- Reviewers get alerts (inbox, email, push) whenever a plan is submitted or
  resubmitted. They are reminded every day until the plan is
  reviewed.
- A reviewer either agrees to the plan, which records who and when, or
  denies it with comments, which sends it back to the IC for a revised
  version.
- An IC never reviews their own plan, even if they are a
  reviewer.
- Every version and decision is kept.
- Overdue or unreviewed plans appear on the coordinator's to-do list.

### Library

- Approved plans go into an ops plan library automatically, tagged by
  vendor, event name, location and year, for quick reference next year
  (for example yearly parades).
- Search and filter by vendor, event, year and location.
- When a coordinator creates or copies a job for a repeat event, the app
  offers last year's plan as the starting point.
- Everyone who can work details can read the library.

## 11a. Deputy notes

- Deputies can pass on what they learn about a vendor or site to future
  deputies. Example: a note about Lakeview Community learned on one
  detail.
- From any detail they worked or are signed up for, a deputy can submit
  a note for that vendor as a whole, or for just one of its locations
  (for example one school in a district).
- A coordinator reviews each note: approve (optionally editing the
  wording first) or deny with an optional reason. The deputy is alerted
  either way. Pending notes appear on the coordinators' to-do list.
- Approved notes appear in a "Deputy notes" section on every current and
  future detail for that vendor (or that location), showing the author's
  first and last name and the date the author wrote it.
- The vendor never sees deputy notes, in the portal, on invoices or in
  any email.
- Coordinators can edit or retire a note later; retired notes stop
  showing but stay in the history.

## 12. Billing and invoices

### 12.1 Billing a detail

- Billing unlocks only after the detail's scheduled end time.
- The person confirms or changes start and end. Any change requires a
  reason. The original and changed hours are both kept.
- Billing generates an invoice PDF and, depending on the review mode,
  emails it to the vendor or holds it for review.
- Paid on the spot: the person marks it paid while billing and enters the
  check number or other reference.
- Payment methods come from a list coordinators can edit. Defaults: Check
  handed to deputy, Check mailed, Cash, Ramp, Bill.com, Other.
- When paid on the spot, the invoice is still generated and emailed to
  the vendor, marked "Paid", as their receipt.
- Paid later: the person marks it paid from their billing page, with date
  and reference.

### 12.2 Invoice

- Sequential agency-wide invoice number (for example ED-000123).
- Agency header on invoices and report PDFs: agency logo, agency name,
  the Sheriff's name, address, phone and website, from an agency profile
  that coordinators maintain. The logo also appears on the sign-in page
  and app header.
- Shows vendor, job number, date, location, hours, rate, total, and
  payment instructions.
- The person is the payee. The "Pay to" block shows their name, mailing
  address and email, for payment logistics (where to send a check, who it
  is payable to). A mailing address is required in the profile before
  billing.
- The agency never receives the money.
- Payment disputes and non-payment go through the
  coordinator, not the person: the invoice names a coordinator billing
  address (admin setting) for questions, and the email reply-to is that
  address.

### 12.2a Minimum billable hours

- Agency minimum billable time per detail, set by admins. The owner's
  agency uses 4 hours.
- Overridable per vendor and per job, and by a coordinator
  when reviewing or editing an invoice (reason logged).
- A detail that runs shorter than the minimum bills the minimum.
- Sent as a PDF attachment through the agency's SMTP server.
- W-9: each person uploads a W-9 to their profile. A checkbox at billing
  attaches it to the invoice email as a PDF (decided: attachment, not a
  link). Profile shows the W-9 upload date and reminds
  people to update it when name or address changes.

### 12.3 Review modes (admin setting)

1. Send immediately: every invoice goes out as soon as the person bills.
2. Review changed hours only (default): goes out immediately if hours
   match the schedule; held for coordinator approval if the person changed
   them.
3. Review all: every invoice waits for a coordinator.

### 12.4 Coordinator actions on a billed detail

- Approve and send.
- Edit hours or rate with a required reason, then send. The person is
  alerted.
- Send back to the person with a comment. The detail returns to Ready to
  bill.
- If an invoice was already sent, the corrected one keeps
  the same number, is marked "Revised", and states that it replaces the
  earlier copy.
- All actions logged.

### 12.5 Earnings dashboard and history (every user)

- Dashboard: earned this month and this year, paid, outstanding, details
  and hours worked, and a year-by-year history.
- Billing history: totals, a monthly chart, and an exportable list
  filtered by date range and vendor. Columns: job, vendor, date,
  scheduled hours, worked hours, rate, total, invoice sent date, paid
  date, reference.
- Tax summary for any year (for IRS requests): paid by vendor and in
  total, with every invoice listed, downloadable as PDF (with the agency
  header) or CSV. Counted in the year the deputy marked the payment
  received (cash basis: a December detail paid in January counts in the
  new year). Each row also shows the vendor's reported payment date, and
  rows where the two dates fall in different years are flagged so the
  deputy can reconcile against the vendor's 1099. Billed-but-unpaid is
  shown separately. The app does not give tax advice.
- History is kept indefinitely.

### 12.6 Reports (coordinators and admins)

- Agency-wide or for specific deputies, vendors, job types or locations.
- Any period, grouped by day, week, month or year, and by deputy, vendor,
  job type, location or status.
- Measures: count, hours, billed, paid, outstanding.
- Reports are available for everything that happens: jobs, sign-ups,
  cancellations and late cancellations, no shows, vendor requests,
  invoices, payments, payment issues, ops plans, locks and overrides,
  suspensions, messages, and the full audit log.
- Built-in reports (for example agency billed and paid by month, earnings
  by deputy, billing by vendor, unpaid by responsible party and age, fill
  rate, hours against caps), plus saved custom reports.
- Export to CSV or PDF. Coordinators can open any deputy's earnings
  dashboard and tax summary.

### 12.7 Payment issues

- Once the vendor's response time has passed without payment (12.10),
  the person can choose "Report non-payment" on it, with an optional
  note.
- This opens an issue for coordinators with invoice, vendor contact,
  amounts and dates attached.
- Coordinators contact the vendor, log notes, and close the issue as Paid,
  Resolved or Written off. The person sees status and notes.
- Marking the invoice paid closes the issue automatically.
- The vendor record shows open and past issues.

### 12.7a Vendor payment hold

- A coordinator can put a vendor on payment hold for non-payment, at any
  point, with a reason.
- While on hold, all of that vendor's future details are locked: closed
  to sign-ups and backups and hidden from open lists, and the vendor
  cannot request or edit details.
- People already signed up keep their spot, but the detail is locked:
  they may not work it until the hold is resolved. The job page and their
  calendar show "Vendor on hold: do not work this detail", they are
  alerted when the hold is placed and when it is lifted, and billing stays
  closed for a locked detail.
- A locked detail is never canceled automatically. When its start time
  arrives with the hold still in place, it goes on the coordinators' to-do
  list as "Locked detail started: cancel", and stays there until a
  coordinator cancels it. Locked details starting within 24 hours
  also show on the to-do list as a heads-up.
- Pay when a locked detail is canceled depends on when the hold was
  placed:
  - Hold placed inside the late cancellation window (default 24 hours
    before the start): the vendor still owes everyone signed up the
    minimum billable time (4 hours). Cancelling creates a new unpaid
    late cancellation invoice for each of them, which follows the normal
    payment responsibility flow (12.10). A coordinator can waive it with a
    reason, as with any late cancellation.
  - Hold placed earlier: no pay, unless the coordinator chooses to apply
    it when cancelling.
- The hold stays until a coordinator marks it resolved, as either "fix
  coming" or "handled", with an optional note. Details then unlock under
  the normal release rules, and people signed up are alerted.
- The hold, its reason and its resolution are on the vendor's history.
- Optional reminder email to the vendor when their response time runs
  out, sent from the agency: off by default, coordinators can turn it
  on.

### 12.8 Vendor-side paid marking

- Vendors can mark an invoice paid on their side, for their own tracking,
  with date, method and reference.
- This does not mark it paid for the deputy. The deputy
  sees "Vendor reports paid on Dec 3 by Check mailed, #1042" and confirms
  when the money arrives. If it never arrives, the deputy can still report
  non-payment; the issue shows the vendor's paid note.
- The deputy must respond within a set time or sign-ups lock (10.7).

### 12.9 Late vendor cancellation pay

- If a vendor (or a coordinator on the vendor's behalf) cancels a detail
  within 24 hours of its start (customizable), everyone signed up is paid
  unless a coordinator or admin waives it for that job with a reason.
- The amount is the minimum billable time (4 hours) at the job's rate. A
  setting can change it to the scheduled hours.
- Each person bills the canceled detail like any other; the invoice says
  "Late cancellation".

### 12.10 Payment responsibility and tracking

Every unpaid invoice is always the responsibility of exactly one party:
the deputy, the coordinator, or the vendor. It stays open until the
deputy and the vendor both mark it paid.

| Situation | Responsible | What they do |
|---|---|---|
| Held for review, or sent back | Coordinator, then deputy | Approve, or fix and re-bill |
| Sent, nobody has marked paid | Vendor | Pay and mark paid |
| Vendor marked paid, deputy has not | Deputy | Confirm received, or report non-payment |
| Deputy marked paid (for example paid on the spot), vendor has not | Vendor | Confirm payment in the portal |
| Deputy reported non-payment | Coordinator | Work it with the vendor; can mark the issue as waiting on the vendor or the deputy, which moves responsibility to them |
| Both marked paid | Nobody | Closed |

- The invoice, the deputy's billing page, the vendor portal and the
  coordinator to-do list all show who is responsible, for how long, and
  when their time is up.

**Response times.** Each party has a default time to handle their step,
customizable by coordinators. The clock starts when the invoice becomes
that party's responsibility. Nothing locks or escalates while a party is
still inside their time.

| Party | Default (customizable) | When the time is up |
|---|---|---|
| Vendor | 30 days | Shown as overdue; the deputy can report non-payment; optional reminder email to the vendor |
| Deputy | 30 days (allows a mailed check one to two weeks to arrive) | Payment acknowledgment lock, if on (10.7) |
| Coordinator | 7 days | Shown as overdue on the to-do list; all coordinators and admins alerted |
- Everything is tracked: every mark, report, note, reminder and change of
  responsibility goes on the invoice's timeline with who, what and when.
- Notes at each payment step (vendor paid, deputy paid, report
  non-payment, issue notes, waiting on, send back) are optional. Each
  step offers default notes to pick from (for example "Check handed to
  me at the detail", "Vendor says check was mailed", "Left voicemail with
  vendor"), and coordinators manage those lists. Reasons stay
  required where they justify an exception: changed hours, rule
  overrides, waivers, write-offs, removals, suspensions and vendor
  restrictions.
- A coordinator can close an invoice as Paid or Written off
  with a reason when one side never responds (for example a vendor that
  never logs in to confirm a payment made on the spot).
- The payment acknowledgment lock (10.7) only counts items that are the
  deputy's responsibility. Once the deputy reports non-payment, the
  deputy has done their part.

## 12.11 API access and manuals

**API access**
- The whole site's data is reachable through the REST API: every record
  (users, vendors, details, positions, sign-ups, invoices, payments,
  issues, ops plans, the audit log and the rest), with paging and
  "changed since" filters, plus a full export of every table as JSON or
  CSV.
- Access uses API keys. Only admins create them, since they
  are a security setting; each key is read-only or read-write, can expire,
  is shown once, and every use is logged. W-9 files need an extra
  permission on the key. Writes through the API follow every rule the app
  enforces.
- Interactive API documentation is built in.
- No direct database login; the API and export cover
  reporting tools and integrations without exposing the database.

**User manuals**
- Manuals for deputies, for coordinators and admins, and for
  vendors, with step-by-step instructions and a screenshot for each step.
- Available inside the app (Help) and as PDFs with the agency header.
- Screenshots are taken automatically in training mode, so they
  never show real data and are refreshed with every new version.

## 13. Security and privacy

- Two-factor sign-in (see 7).
- Role-based permissions enforced in the API, never only in the UI. Vendor
  users can reach only their own vendor's data.
- W-9s: encrypted at rest by the storage provider and by the app (separate
  key), downloadable only by the owner, coordinators and admins, every
  view and download logged.
- Audit log for all changes to jobs, assignments, hours, invoices,
  suspensions, overrides, settings and permissions: who, what, when,
  before and after.
- Rate limiting on sign-in and password reset.
- Daily database backups with 7 days of point-in-time recovery from the
  managed provider; file storage versioning.
- No SSNs in emails except inside an attached W-9 the person chose to send.

## 14. Alerts and messages

### Channels

In-app inbox, email (through the agency SMTP), and phone push (installed
web app). Each person chooses email and push per alert type and can set
quiet hours. Alerts sent by coordinators always arrive.

### Automatic alerts (only when someone needs to act or their own detail changed)

| Event | Goes to |
|---|---|
| Spot opens for backups | Backups, in turn |
| Spot opens to everyone, or a watched detail is released | Deputies watching that detail (eligible ones only) |
| Job changed (including rate), canceled, locked or unlocked | Assigned personnel and backups |
| Assigned or removed by coordinator | That person |
| Detail ready to bill; unbilled reminders | That person |
| Invoice edited or sent back | That person |
| Vendor request submitted or edited | Coordinators |
| Invoice waiting for review | Coordinators |
| Payment issue opened | Coordinators |
| Ops plan due, overdue | IC and coordinators |
| Ops plan submitted or resubmitted | Ops plan reviewers |
| Ops plan agreed to or denied | IC and coordinators |

### Messages

- A Message Center: Inbox and Sent, New Message,
  filter and search, mark read or unread, delete (from your own view
  only; the record is kept), reply, and an optional linked job.
- Any user except vendors can message all users or selected users. Pick
  people by name, or groups: a rank, everyone on a job (signed up and
  backups), coordinators.
- Sending a message alerts each recipient in the app and by push. Each
  user can opt in to also get other users' messages by email, with the
  full message in the email.
- Coordinators' messages always arrive, regardless of preferences.
- Personnel can message coordinators about a job ("Message coordinator").
- A coordinator setting can limit "all users" messages to coordinators
  if it gets noisy; it is on for everyone by default.
- Vendors are outside the Message Center: they cannot send messages and
  cannot be messaged in the app. They reach coordinators by email, which
  keeps deputies out of vendor payment talk.

## 15. Screens

| Area | Screens |
|---|---|
| Personnel | Home (to-do, caps, next detail, open now, waiting on payment), Jobs (search with filters and sorting, "only details I can work" toggle, list), Recommendations (goal progress and suggested details), Calendar (day, week, month, list; export to phone calendar), Job page, Billing (to bill, history, payment issues), Earnings (dashboard, tax summaries), Messages, Profile (contact, W-9, alerts, theme, work schedule, earnings goal, hidden vendors) |
| Coordinator | To-do list (vendor requests, invoice review, payment issues, ops plans, unfilled jobs starting soon, billing locks), Vendors, Job editor (copy, recurrence, series edits), Assign and remove, Payments by responsible party, Reports, Ops plan library |
| Management (coordinators and admins) | Users, ranks, suspensions, seasons and caps, release schedule, warning text, job types, payment methods, vendor settings, billing and reminder settings, ops plan reviewers, special flags and who holds them, audit log |
| System (admins only) | Email server (SMTP) with a test send, security settings |
| Vendor | Details (list and calendar), New request, Detail page, Invoices |

### Look

- Design: DESIGN.md (built from the approved mockup direction, row D); screens as built are in the manual screenshots, docs/manuals/images/.
- Daylight layout: light, roomy cards, blue accent, Inter type.
- Roster as a table (name, rank, status, signed up; cancellations struck
  through).
- Pay is always shown as the total and the hourly rate together (for
  example "$280 at $70/hr") on every card, list, pin and summary that
  shows a detail's pay.
- Staffing card: a grid of squares, solid for filled spots, dashed for
  backups.
- Day and night themes. Follows the device setting by default; each user
  can set a preference in the app.
- Phone first: bottom tab bar (Home, Jobs, Calendar, Billing, Profile) on
  phones, top navigation on desktop.
- Accessible: real buttons and links, 44 px touch targets, WCAG AA contrast
  in both themes.

## 16. Admin settings (summary)

Agency profile (logo, name, Sheriff's name, address, phone, website);
release day and time; seasons and caps; week start; sign-up warning text;
ranks and order; special flags and position types; job types; vendor permission
settings; backup first-chance window; invoice review mode; coordinator
billing reply address; SMTP; invoice numbering; unbilled reminder
frequency, grace period and lock; non-payment report threshold; vendor
reminder emails; ops plan reviewers, default due offset and late-IC window.

## 17. Build order

1. Accounts, roles, ranks, vendors (no portal), jobs, release, sign-up
   rules, calendar.
2. Billing, invoices, W-9, SMTP, review modes, payment tracking.
3. Backups, cancellation flow, alerts and push, messages.
4. Vendor portal, ops plans and library, unbilled lock, payment issues.
5. Native app on the same API (later).

## 18. Left to the builder

Library choices marked **[Builder]**, data model details, API shape within
the REST and OpenAPI decision, PDF layout, hour rounding (decided: always up
to the next 15 minutes), search implementation, report set beyond those listed.

## 19. Open questions

1. Current weekly and monthly limits (entered at setup).
