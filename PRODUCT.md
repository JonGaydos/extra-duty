# Product

<!-- impeccable:product-schema 1 -->

<!-- Inferred from docs/specs/2026-11-22-extra-duty-design.md and the approved mockups in docs/mockups/project/ during Task 36. Confirmed by the owner on 2026-11-24, with one correction: deputies use phone and desktop about equally. -->

## Platform

web

## Users

- **Deputies (personnel role):** off-duty sheriff's office staff (Posse, CSO, Deputy Sheriff, Dispatcher) who find, sign up for, work and bill paid details. They use a phone and a desktop about equally (roughly 50/50): a phone outdoors, before or after a shift, sometimes at night in a patrol car, and a desktop at home or at the office for planning the month and billing. Deputy screens are designed for both equally.
- **Coordinators and admins:** agency staff who post details, review vendor requests and invoices, chase payment issues and keep the roster full. Mostly at a desk on a desktop browser.
- **Vendors:** businesses, churches, schools and event organizers who request details and pay deputies directly. Occasional users on a desktop or phone.

## Product Purpose

An off-duty detail system that a law enforcement agency runs for itself. Vendors request details, deputies sign up first come, first served under rank, hour-cap and billing rules, and after the detail the deputy bills the vendor with an emailed PDF invoice. Success: coordinators stop sending invoices and announcing openings by hand, and deputies can do everything from a phone or a desktop.

## Positioning

The agency runs its own system and never touches detail money: vendors pay deputies directly.

## Operating Context

- Deputies sign up the moment details release (monthly release at a set day and time), on whichever device is at hand, so speed and clarity matter on a phone and on a desktop alike.
- Deputies split about evenly between phone and desktop, so no deputy screen is designed phone-only: each gets the same care at phone and desktop sizes.
- Hour caps (rolling 24 hours, week, month by season) and billing locks decide who may sign up; the app shows each rule and whether it is met.
- Pay always shows as the total and the hourly rate together ("$280 at $70/hr").
- Installed to the home screen as a web app; alerts arrive by in-app inbox, email and push.

## Capabilities and Constraints

- Roles: admin, coordinator, personnel, vendor. Admin includes coordinator powers; coordinator includes personnel powers.
- Two-factor sign-in by emailed 6-digit code; no SSO.
- The agency never processes payments.
- Native apps are planned later; the web app is API-first.

## Brand Commitments

- Working name "Extra Duty". The agency logo appears on invoices and sign-in (asset not yet provided).
- Plain, professional copy; no emojis.

## Evidence on Hand

- Approved screen mockups: docs/mockups/project/*.dc.html (phone deputy screens, desktop coordinator screens, vendor request, invoice, one night-mode screen).
- No real agency logo, photography or testimonials are in the repository; do not invent them.

## Product Principles

- Phone and desktop equally for deputies, desktop first for coordinators.
- Rules are visible: every block or warning says which rule and how to clear it.
- One way to show pay, everywhere.
- Calm, legible, trustworthy over expressive.

## Accessibility & Inclusion

WCAG 2.2 AA in both day and night themes; 44 px touch targets; real buttons and links; visible keyboard focus.
