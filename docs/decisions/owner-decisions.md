# Owner Decisions

Decisions and requests from the owner made during the build, from 2026-11-23 on. Each one changes or adds to the design spec (`docs/specs/2026-11-22-extra-duty-design.md`). Where the two disagree, the later decision here wins. Dates are when each was decided.

## Design and platform

- **Design system (2026-11-23).** Every screen follows `DESIGN.md`, built from the approved mockups (Inter, day and night themes), and front-end work uses the impeccable design review.
- **Product brief (2026-11-24).** `PRODUCT.md` is confirmed with one correction: deputies use phone and desktop about equally, so both are designed with the same care.
- **Phone tab bar (2026-11-24).** The bottom bar is full width and pinned flush to the bottom edge, not floating. Only the main area scrolls, so the Firefox Android address bar stays visible.
- **Links (2026-11-24).** Text links are underlined at rest. Action links carry an icon and have a 44 px tap area. Phone and email links show an icon and the full value. Disclosure toggles are buttons with a rotating chevron.
- **Logos (2026-11-24).**
  - Accepted formats are PNG, SVG, JPG and WebP. Margins are trimmed, and logos are never cropped or stretched.
  - The header logo is 40 px tall, and logos about 1.3:1 or wider get a wider slot.
  - In night mode, the light plate sits only behind logos that have no transparency.
  - On a white day header, white artwork can disappear. This is accepted.
- **Addresses (2026-11-24).**
  - Addresses are checked against OpenStreetMap only. The field offers "Did you mean", or "Keep as entered" with a "Not verified" badge, and never blocks saving.
  - Detail and safety addresses have a pin that can be dragged.
  - Address links offer Google Maps, Apple Maps and OpenStreetMap, with "Remember my choice".
- **Phone numbers and contacts (2026-11-24).**
  - Every phone field formats as ###-###-#### and must have 10 digits.
  - Contact names must contain a letter.
  - Each vendor keeps a list of site contacts. Picking a contact on a detail fills in the phone number.
  - The vendor record shows its fields one per line.

## Details and scheduling

- **Calendar (2026-11-24).** The calendar shows every detail the viewer is allowed to see, with a color key and filters for each person.
- **Hold and Release (2026-11-24).** One button holds or releases a detail or a whole series, with a "Release now" option.
- **Quick and bulk edits (2026-11-24).** Coordinators can change times, rates and other fields quickly on one detail or on many at once.
- **Conflicts on time edits (2026-11-24).** When an edit moves a detail's time, the app re-checks every assigned deputy for overlaps and hour caps.
  - Each conflict is listed, and the coordinator must either resolve it or override it.
  - An override needs an explicit warning, a confirmation and a reason, and it is logged.
  - Only coordinators can place a deputy into a conflict.
- **Hourly rate range (2026-11-24).**
  - The agency sets a minimum and maximum hourly rate.
  - A coordinator can approve a rate outside the range on a single detail, with a reason.
  - That exception is shown only in the audit log and on the detail's staff page, never on invoices.
- **Copying a detail (2026-11-25).** A copy carries the detail itself (vendor, location, title, description, notes, positions, rate, flexible times, officer safety, site contact and attachments) but never the people who were signed up or working it. The copy starts with an empty roster.
- **Overnight details (2026-11-26).** A detail still running stays on today's lists until it ends, even if it started before midnight. The month calendar still places a detail on the day it starts.
- **Reactivating a canceled detail (2026-11-24).**
  - Coordinators can bring back a canceled detail before its end time, with a required reason.
  - It starts fresh with an empty roster. The former deputies and the vendor are notified.
  - The history shows both the cancel and the reactivation.
  - Any late-cancel pay not yet billed is canceled.
- **No billing before the end time (2026-11-24).** Nothing can be billed before the detail's scheduled end time, including late-cancel pay. This means a detail can never be reactivated after its late-cancel pay was billed.

## People and reports

- **Personnel activity report (2026-11-24).** This report is for coordinators and admins.
  - It shows who works the most and who cancels the most.
  - Cancellations are split into Gave away, Removed by coordinator, Removed by suspension, No-show and Vendor late cancel.
  - Only Gave away, Removed by coordinator and No-show count toward the cancellation total. A vendor's late cancel and a suspension removal never count against the deputy.
  - There is no separate deputy "late drop" count.
- **Sign-up history on a detail (2026-11-24).** Coordinators and admins see every sign-up on a detail, including canceled ones (who, when and why). Deputies see only the current roster.
- **Suspensions are a personnel matter (2026-11-24).** Only coordinators and admins ever see "Removed by suspension". The deputy sees a plain "Canceled". Vendors see no reason, and no alert or email mentions a suspension. The suspended deputy's own "Your account was suspended" notice appears only in their in-app inbox, never by email (2026-11-25).
- **People who leave (2026-11-25).** Deactivating someone shows a checklist first: their upcoming sign-ups, past details not yet billed, and unpaid invoices. A reason and last day are required and logged. Upcoming sign-ups after the last day are removed, and the spots go to backups or reopen; vendors are not told why. Unbilled past details stay listed for staff to bill on the person's behalf or write off with a reason. Unpaid invoices stay open, because vendors still owe the person. An account can be reactivated later with a reason; old sign-ups are not restored.
- **Coordinators' own invoices (2026-11-24).** A coordinator may handle their own invoices and payment issues. Every action is logged.

## Invoices and billing

- **Batched sending (2026-11-24).**
  - Invoices can go out immediately, weekly, every two weeks or monthly, and a vendor can have its own schedule.
  - Each batch has a cover sheet with a grand total.
  - The coordinator can attach W-9s for every deputy in a batch.
- **Approve, don't send (2026-11-24).** At approval, the coordinator chooses "Approve and send" or "Approve, don't send", case by case.
  - Each vendor has a default setting for this.
  - An invoice that is not sent stays hidden from the vendor until it is sent.
- **Paid on the spot (2026-11-24).**
  - An invoice paid on the spot closes as paid.
  - It can still be sent to the vendor marked Paid, with $0.00 due.
  - In a batch, it adds $0.00 to the total due.
- **Resend and PDF (2026-11-24).**
  - Staff can resend any sent invoice, with an optional extra address. The W-9 never goes to that extra address.
  - Staff can download any invoice as a PDF.
- **Data export (2026-11-24).** The admin data export and the API include every table except passwords and security tokens.

## Notifications

- **Agency notification settings (2026-11-24).** Admins and coordinators can switch Email and Push on or off for each notification type and each group.
  - Each person's own settings still apply under these switches.
  - The in-app inbox always keeps a record.
  - Sign-in codes, invites, password resets and the invoice email itself are always on.
- **Vendor cancel notice (2026-11-24).** When staff cancel a detail, the vendor gets an email (on by default, and it can be switched off).

## Testing and deployment

- **End-to-end tests (2026-11-23, 2026-11-24).**
  - A single test run signs in as vendor, coordinator, admin and deputy at the same time and walks every feature.
  - The tests can be watched live from another computer at port 3211.
  - Recorded runs keep their video and traces in dated folders, saved after each test file, so a crash loses at most the test in progress.
- **Self-hosting (2026-11-24).** Docker Compose with Caddy for automatic HTTPS, plus a guide covering install, backups, updates and restore.
- **Open source (2026-11-25).** The owner releases Extra Duty publicly as open source under AGPL-3.0, from a personal GitHub account. The public release is made generic first: no owner name, agency name, home network address or real local organizations. It is published with a fresh single-commit history, while the full history stays private. The public app makes no reference to any other software product or vendor, and contains no IP addresses, real names, contact details, machine names or local tooling references.
- **Code quality cleanup (2026-11-25).** Every SonarCloud finding is addressed, area by area: real risks first, then mechanical tidy-ups, then rewrites of nested conditions, complex functions and sequential waits, with no behavior change and full tests each round. All rounds are done locally and checked with the same rules run locally; GitHub receives one combined update at the end, not one per round. A wider review (library vulnerabilities, dead code, stricter type checks, licenses, secret and privacy scan) runs before that update.
- **DigitalOcean (2026-11-24).** This will be decided after deployment. Nothing is connected now.
