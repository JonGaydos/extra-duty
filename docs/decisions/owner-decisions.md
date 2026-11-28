# Owner Decisions

Decisions and requests from the owner made during the build, from 2026-11-23 on. Each one changes or adds to the design spec (`docs/specs/2026-11-22-extra-duty-design.md`). Where the two disagree, the later decision here wins. Dates are when each was decided.

## Design and platform

- **Design system (2026-11-23).** Every screen follows `DESIGN.md`, built from the approved mockups (Inter, day and night themes), and front-end work uses the impeccable design review.
- **Product name (2026-11-26).** The app is named Signal 90; "Extra Duty" becomes its descriptor. The combined form is "Signal 90 · Extra Duty", and "Signal 90" alone is used where space is short (see DESIGN.md, Name). Technical names stay as they are so existing installs keep working: package, Docker image, container and Compose project names, folders, databases, cookies, the `ed_live_` API key prefix, environment variables and the repository address. The agency name setting is separate and unchanged.
- **Product brief (2026-11-24).** `PRODUCT.md` is confirmed with one correction: deputies use phone and desktop about equally, so both are designed with the same care.
- **Phone tab bar (2026-11-24).** The bottom bar is full width and pinned flush to the bottom edge, not floating. Only the main area scrolls, so the Firefox Android address bar stays visible.
- **Links (2026-11-24).** Text links are underlined at rest. Action links carry an icon and have a 44 px tap area. Phone and email links show an icon and the full value. Disclosure toggles are buttons with a rotating chevron.
- **Deputy navigation (2026-11-26).** Deputies get Home, Details, Calendar, Billing, Messages and Profile on the desktop, and Home, Details, Calendar, Billing and More on the phone, where More lists Map, Messages, Profile and Help. Map is no longer its own tab; the List, Calendar and Map buttons link the three views.
- **Staff have everything a deputy has (2026-11-26).** Coordinators and admins also work details, so their navigation always includes every deputy section: on the desktop a "My work" group (My work, Open details, My billing, Profile) at the right of the top bar, and on the phone the same items plus Map on More. The four phone tabs do not change. A unit test guards it. Replaced by "Same screens for everyone" (2026-11-27).
- **Same screens for everyone (2026-11-27):** coordinators and admins see the deputy tabs and pages, with staff tabs (To-do, Payments, Vendors, Reports, Management) added and staff controls on the shared pages.
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

- **Sign-in codes per role (2026-11-26).** Management, Security has an admin-only "Require emailed sign-in codes" switch for coordinators, deputies and vendors, on by default. Admins always need a code, because they can change the email server and security settings and export all data. Turning a role off needs a confirmation that warns the site holds W-9s with Social Security numbers and pay records, is audited with before and after values, and applies at the next sign-in while open sessions stay. Throttling and lockout do not change, and the native app's bearer sessions follow the same rule.

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

- **Vendor managers (2026-11-27).** Staff can make a deputy the manager of a few chosen vendors (Management, Users, "Vendors this person manages"; audited), so a coordinator does not have to handle them, such as a school resource sergeant for two or three schools.
  - For those vendors only, the deputy creates and edits details (positions, times, a rate inside the agency range, description, contract, copy and repeat), holds and releases them, cancels and reactivates them, assigns and removes people under the coordinators' conflict and override rules, sees the roster and sign-up history, decides the vendor's requests and keeps its locations and site contacts. The API enforces the same scope.
  - They never see W-9s, other people's payments or invoices, other vendors, the vendor record, staff reports, To-do, Management or the audit log, and cannot approve a rate outside the range, mark no-shows, name the Incident Commander, hold an invoice or waive late-cancel pay. Otherwise they are a deputy.
  - Same screens: they keep the deputy tabs and get a Manage tab with their vendors, requests and upcoming details; Details and Calendar show Manage on their vendors' details, which opens Manage this detail. Every action is audited under their name, and coordinators' alerts about these vendors' requests and changes also go to them.

- **Confidential details (2026-11-27).** Coordinators and admins can mark a detail Confidential (for example VIP or dignitary protection), on create or on Manage this detail, with a reason both ways; both are audited.
  - Only coordinators, admins and the people assigned see it. It is never open for sign-up or released (no hold or release, no backups or watches); people are added only by assignment, under the usual conflict and override rules.
  - Everyone else, the detail's own vendor and its vendor managers included, finds nothing: not in lists, the calendar, the map, Home, recommendations, search, messages, the ops plan library or the API, and its number answers like one that does not exist.
  - Emails and push say only "You were assigned to a confidential detail on <date>. Open Signal 90 for the details." Personal calendar feeds show "Confidential detail" with the times only.
  - Billing and the invoice to the vendor are unchanged. Staff reports include it and can group by Confidential; a deputy's own earnings and tax summary call it "Confidential detail".
  - Every open, in the app or the API, is logged with who and when, and staff see the list on Manage this detail. A copy or repeat of a confidential detail stays confidential.

- **Giving a spot away (2026-11-27).** A deputy no longer cancels a sign-up: they choose **Give away this spot** with a reason and stay assigned and responsible until someone else takes it over. Only a coordinator, an admin or the vendor's manager removes them outright (with a reason, counted as Removed by coordinator).
  - While offered, the roster shows **Offered** and the spot is open to others under the normal rules: backups first (the backup window), then anyone eligible, with rank, flags, caps, conflicts and release all applying. The deputy may withdraw the offer while it is unclaimed, and the detail offers "Would you like to let others know this spot is available?" with **Send a message** (New message with the detail under About a detail; the offered spot counts as assigned).
  - The first eligible taker replaces the deputy: the original sign-up ends as **Gave away** (counted in the activity report), both people are told, and the vendor too when vendors see names. The deputy's hours and calendar free up.
  - Inside the late cancellation window setting (24 hours by default), an offer nobody took shows on To-do as "Offered spot not taken: <name>, #<number>, <date>" and the deputy is reminded once. Nothing is removed automatically; a deputy still holding the spot at the start works and bills it as normal. Late-cancel pay for vendor cancels is unchanged.
  - Staff can remove the deputy, assign a replacement directly or cancel the offer; each is audited and the sign-up history shows "Offered by <name> on <date>" and then "Taken over by <name>", "Offer withdrawn" or "Offer canceled". A confidential detail is never offered, so staff handle those; making a detail confidential cancels its open offers. Sign-ups canceled before this change stay canceled.
  - The sign-up panel shows exactly one current state (signed up; offered, waiting for someone to take over; taken over by <name>; removed) and refreshes after each action. Backups leave with **Leave the backup list**, pending shorter shifts with **Cancel my request**.

- **Audit log filters, exports and records (2026-11-27).** Whoever can read the audit log (coordinators and admins) can filter it by who did it, who it is about (their account, sign-ups, W-9s, lock overrides and invoices), action type in plain-word groups (several at once), detail, vendor, invoice, an agency-time date range with presets, text in the reason and summary, and whether system actions show, paged newest or oldest first, all in the address bar. Entries can be ticked, or all matching selected, and exported as CSV or printed as an Audit Record PDF.
  - The CSV has the entry ID, the time in agency time with the zone written out, who (name and role), the action in plain words, the subject, detail, vendor, invoice, reason, readable changes, the IP address if recorded and system or person. It is formula-guarded and streamed.
  - The Audit Record is a formal record for presentation, discipline or court: a cover (agency name and logo, the filters in plain words, the number of entries, who made it and when, the statement that entries are written as the action occurs and cannot be edited or deleted in the application), each entry with a before and after table and its system context, a footer on every page with page X of Y, the record ID (AR-000012) and the integrity code, and Prepared by and Reviewed by signature lines. One entry prints from its own view. Over 2,000 entries it asks first, and 10,000 is the most one record holds.
  - The integrity code is a SHA-256 of the canonical entry data; the record keeps its entries and code, and an admin checks a printed copy on Verify a printed record by the record ID and, optionally, the printed code. Every export, print and check is audited with who, the filters and the number of entries. Passwords, codes, tokens, API key secrets, file contents and W-9 details never appear, only references; personnel matters such as suspensions do. The log records no IP address or device today, so those columns stay empty until it does.

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
- **The deputy's confirmation closes the invoice (2026-11-26).** This replaces the spec's two-sided rule, where an invoice closed only when both the deputy and the vendor marked it paid. Vendors do not work for the agency, many have no account, and they cannot be made to click.
  - When the payee confirms payment, the invoice closes as paid, shown to staff as "Paid (confirmed by deputy)". Its response clock, overdue status, vendor reminders, coordinator to-dos and alerts stop, and an "unconfirmed payment" sign-up lock clears.
  - The vendor's own "Mark paid" stays optional, for its records; a later mark goes on the timeline. The vendor portal shows the invoice as Paid.
  - Payments has a quiet "Vendor not confirmed" filter for deputy-confirmed invoices the vendor never marked: no counts, no alerts, never overdue.
  - Reports count an invoice as paid once the deputy confirms it.
  - Invoices the deputy already confirmed under the old rule were closed as paid by the release step, each with a system audit entry.
- **Resend and PDF (2026-11-24).**
  - Staff can resend any sent invoice, with an optional extra address. The W-9 never goes to that extra address.
  - Staff can download any invoice as a PDF.
- **Data export (2026-11-24).** The admin data export and the API include every table except passwords and security tokens.

- **Billing action banner (2026-11-27).** Home shows a banner while the person has worked details not billed yet ("You have 2 worked details to bill. Billing them keeps your sign-ups open.") or invoices waiting on them, such as a payment the vendor reported to confirm or a returned invoice to fix ("1 invoice needs your attention."). **Go to billing** opens Billing at To bill, or at Waiting filtered to the invoices that need them. With the billing lock already active it says "Sign-ups are locked until you bill these." It follows DESIGN.md's action banner, cannot be dismissed while action is needed and applies to everyone who bills, coordinators and admins included.

## W-9s

- **W-9 review (2026-11-27).** Every new W-9, uploaded by the person in Profile or by staff on the person's page (Management, Users), starts as Pending review and shows on To-do as "W-9 to review".
  - Staff approve it with the signature date and the IRS form revision, or reject it with a reason (such as "Line 2 missing" or "Not signed"). The person is told in the app and by email or push per the notification settings; a rejection includes the reason and a link to upload again. W-9 alerts never go to vendors.
  - Every view, approval and rejection is audited. Staff uploads use the same encrypted storage.
  - A newer upload waiting for review does not replace the approved W-9 until it is approved.
- **W-9 sign-up lock (2026-11-27).** Without an approved W-9, a person cannot sign up, in the style of the billing lock: they can still sign in, see details, bill finished work and be paid. The detail's rules say "Your W-9 needs to be approved before you can sign up". Coordinators can still assign them with the usual override reason.
- **Invoices and W-9s (2026-11-27).** An invoice never attaches a W-9 that is pending or rejected, and never a superseded one when a newer approved one exists. When none can go, the invoice is sent without a W-9.
- **Renewal requests (2026-11-27).** Staff ask one person, a rank, a special flag or everyone for a new W-9 by a due date, with an optional note. People get reminders a week before and the day before. After the due date, anyone asked without a W-9 uploaded after the request and approved is sign-up locked ("A new W-9 was due Jan 31"). The old W-9 stays in history. Staff see each request with who is done, pending review, rejected or missing.
- **W-9 signed this year (2026-11-27).** A vendor can be set to "Requires a W-9 signed this year". Its invoices attach the payee's W-9 only when it was signed in the current calendar year, agency time. Otherwise the deputy sees a notice when billing that vendor, staff see it on the invoice and the vendor page, and the invoice goes without the W-9. Billing is flagged, never blocked, consistent with the sign-up-only lock.
- **W-9s on file at the update (2026-11-27).** W-9s already on file were approved (grandfathered) with the signature date unknown and a system audit entry, so nobody is locked by the update. Staff can ask for new ones afterwards.

## Messages and calendar

- **About a detail (2026-11-27).** The message field "About a job" is now "About a detail". A deputy may link only a detail they are signed up for, pending on or offered a spot on that has not ended; staff may link any detail that has not ended. Past details are never offered, and the server refuses any other link (form and API). A detail a deputy is not on is never offered to them.
- **Message recipients (2026-11-27).** "Send to" is either Everyone (with the count of people) or Choose recipients (people by name, a rank, a detail's roster or the coordinators, as removable chips). A deputy may message the roster only of a detail they may link under About a detail (form and API). Choosing Everyone replaces the chips and offers Undo; no confirmation is asked. Someone covered by more than one chip gets one copy.
- **Calendar link import (2026-11-27).** Adding or changing the calendar link in Profile (or through the API) imports it at once, through the same path and 15-minute limit as Sync now, instead of waiting for the nightly run. The card shows "Importing your calendar..." and then the last fetched time or the error.
- **To-do wording (2026-11-27).** The To-do page counts "To-do: 3 items." and never says something "needs you".

- **Messages that require acknowledgement (2026-11-27).** Coordinators and admins can tick "Require acknowledgement" when composing, with an optional due date (the end of that agency day) and "Lock sign-ups if not acknowledged by the due date", off by default and only with a due date.
  - Until a recipient acknowledges it, Home shows "Important message from <sender>: <subject>. Read and acknowledge." (several show as a count and open oldest first) and every other page a thin bar; neither can be dismissed. "I have read and understand" stays disabled until the person reaches the end of the message, or the message fits on screen. The time is recorded, audited and final.
  - After the due date with the lock on, the sign-up rules show "Acknowledge the message "<subject>" to sign up again" until they acknowledge it; coordinators can still assign with the usual override. A passing check is not listed.
  - Staff see Acknowledged N of M with who has (and when) and who has not, "Remind those who haven't" (the "Acknowledgement reminder" notification, with agency switches and an editable email message) and a CSV export (audited). Overdue messages show on To-do as "Message not acknowledged". A sent message is never edited; a correction is a new message. Vendors are out of scope.

## Notifications

- **Agency notification settings (2026-11-24).** Admins and coordinators can switch Email and Push on or off for each notification type and each group.
  - Each person's own settings still apply under these switches.
  - The in-app inbox always keeps a record.
  - Sign-in codes, invites, password resets and the invoice email itself are always on.
- **Detail reminders (2026-11-27).** The people assigned to a detail are emailed (and pushed, and sent an in-app alert) before it starts, with the description the coordinator wrote.
  - The agency chooses any of 72, 48, 24 and 2 hours before under Management, Reminders and locks (72 and 24 by default; coordinators and admins, audited). On create and edit, staff and the vendor's managers keep those times, choose others for one detail or turn reminders off, and may add a Reminder note.
  - The email carries the detail number and title, vendor, date and time (agency time), location with an Open in Maps link in the person's saved maps app, position and pay, description, reminder note, officer safety notes, site contact and a link to the detail. Push carries a short version.
  - It goes to everyone on the detail at send time, offered spots included; backups do not get it. Each reminder time goes once, from the worker's schedule, and never twice after a restart. Someone assigned after a reminder time passed does not get that one, only the latest due reminder is sent after a gap, a time change moves the reminders still to come, and canceled, held and started details get none.
  - "Detail reminder" is a notification type with agency Email and Push switches and a personal choice. A confidential detail's email and push say only "Reminder: you are assigned to a confidential detail on <date> at <time>. Open Signal 90 for the details."
- **Reminder note visibility (2026-11-27).** A detail's Reminder note reaches only staff, the vendor's managers and the people assigned. It never reaches vendors or vendor API responses, and other deputies do not see it in lists or on the detail, the same way a rate exception's reason is kept back.
- **Editable email messages (2026-11-27).** Every email the app sends has a default message that coordinators and admins can edit under Management, Reminders and locks, Email messages: each notification type's email plus the invoice, revised invoice, batch cover, vendor payment reminder, vendor payment issue, sign-in code, invite, password reset, test email and email server alerts, and the detail reminder. Resends use the invoice message.
  - The list is in plain-language groups, each message with who gets it and when. Each has an editable subject and plain-text body (paragraphs and links), its own placeholders with Insert placeholder buttons, a live Preview with sample values, Send me a test (to the editor's own address), Reset to default, and "Changed by <name> on <date>".
  - Required placeholders cannot be removed (the sign-in code, the invite and reset links, the invoice number and amount), unknown placeholders are refused, values are escaped and never become links, and every save, reset and test is audited with before and after.
  - Sign-in code, invite, password reset, test email and email server alert messages are editable by admins only; coordinators see them read-only and may send themselves a test.
  - Confidential details have separate messages (assigned, update and reminder) that may use only the date and time.
  - The built-in wording is the default, so nothing changes until someone edits a message. Most alert emails start as the alert's title and text, which can be worded around. Training mode and staging use the same messages (each database keeps its own edits) and the outbox shows them as sent. Push and in-app wording stay short and fixed.
- **Vendor cancel notice (2026-11-24).** When staff cancel a detail, the vendor gets an email (on by default, and it can be switched off).

## Testing and deployment

- **End-to-end tests (2026-11-23, 2026-11-24).**
  - A single test run signs in as vendor, coordinator, admin and deputy at the same time and walks every feature.
  - The tests can be watched live from another computer at port 3211.
  - Recorded runs keep their video and traces in dated folders, saved after each test file, so a crash loses at most the test in progress.
- **Self-hosting (2026-11-24).** Docker Compose with Caddy for automatic HTTPS, plus a guide covering install, backups, updates and restore.
- **File storage (2026-11-26).** Self-hosted installs store files on a disk folder; MinIO removed because its images are no longer published; S3 remains available for cloud hosting by settings.
- **Open source (2026-11-25).** The owner releases Extra Duty publicly as open source under AGPL-3.0, from a personal GitHub account. The public release is made generic first: no owner name, agency name, home network address or real local organizations. It is published with a fresh single-commit history, while the full history stays private. The public app makes no reference to any other software product or vendor, and contains no IP addresses, real names, contact details, machine names or local tooling references.
- **Code quality cleanup (2026-11-25).** Every SonarCloud finding is addressed, area by area: real risks first, then mechanical tidy-ups, then rewrites of nested conditions, complex functions and sequential waits, with no behavior change and full tests each round. All rounds are done locally and checked with the same rules run locally; GitHub receives one combined update at the end, not one per round. A wider review (library vulnerabilities, dead code, stricter type checks, licenses, secret and privacy scan) runs before that update.
- **DigitalOcean (2026-11-24).** This will be decided after deployment. Nothing is connected now.
