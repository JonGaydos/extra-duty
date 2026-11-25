---
name: Extra Duty
description: Off-duty detail scheduling for a sheriff's office, phone and desktop equally for deputies and desktop first for coordinators.
colors:
  canvas: "#f4f6f8"
  surface: "#ffffff"
  subtle: "#f7f8fa"
  sunken: "#eef0f3"
  line: "#e3e6eb"
  divider: "#eef0f3"
  field: "#838c9a"
  ink: "#14181f"
  muted: "#5b6472"
  accent: "#2147c2"
  accent-hover: "#16328c"
  on-accent: "#ffffff"
  link: "#2147c2"
  link-hover: "#16328c"
  accent-soft: "#e8eefc"
  accent-muted: "#9db3ee"
  accent-outline: "#6886dc"
  focus: "#2147c2"
  success-soft: "#e7f5ec"
  success-ink: "#146c3a"
  success-line: "#b7e1c6"
  warning-soft: "#fff4e5"
  warning-ink: "#8a4b00"
  warning-line: "#f5d3a3"
  warning-strong: "#c26a00"
  danger-soft: "#fdecec"
  danger-ink: "#8c1414"
  danger-line: "#f2b8b8"
  danger: "#b42318"
  on-danger: "#ffffff"
  attention-soft: "#fdeee6"
  attention-ink: "#b33a06"
  attention-dot: "#d9480f"
  coordinator-soft: "#f1ecfb"
  coordinator-ink: "#5b3ba8"
  cal-open: "#15803d"
  cal-filled: "#c42a2a"
  cal-past: "#4a5a70"
  cal-unreleased: "#b45f00"
  canvas-night: "#0f1318"
  surface-night: "#171c23"
  subtle-night: "#1b2129"
  sunken-night: "#232a33"
  line-night: "#2a313b"
  divider-night: "#232a33"
  field-night: "#687283"
  ink-night: "#e8ecf1"
  muted-night: "#9aa4b2"
  accent-night: "#3d6bf0"
  accent-hover-night: "#3260e0"
  link-night: "#8fb0ff"
  link-hover-night: "#b9ccff"
  accent-soft-night: "#1e2a4a"
  accent-muted-night: "#3a4f8f"
  accent-outline-night: "#56709f"
  focus-night: "#8fb0ff"
  success-soft-night: "#12291c"
  success-ink-night: "#7fd69f"
  success-line-night: "#25553a"
  warning-soft-night: "#33240f"
  warning-ink-night: "#f5b86b"
  warning-line-night: "#5c4220"
  danger-soft-night: "#3a1e1e"
  danger-ink-night: "#ff9b9b"
  danger-line-night: "#6b2b2b"
  danger-night: "#c2362b"
  attention-soft-night: "#3a2010"
  attention-ink-night: "#ff9466"
  attention-dot-night: "#ff7a45"
  coordinator-soft-night: "#2a2140"
  coordinator-ink-night: "#c3aef5"
  cal-open-night: "#4fc77f"
  cal-filled-night: "#f07171"
  cal-past-night: "#8a9ab0"
  cal-unreleased-night: "#f0a64a"
typography:
  page-title-desktop:
    fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif"
    fontSize: "28px"
    fontWeight: 700
    lineHeight: 1.15
  page-title-phone:
    fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif"
    fontSize: "23px"
    fontWeight: 700
    lineHeight: 1.2
  stat:
    fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif"
    fontSize: "21px"
    fontWeight: 700
    lineHeight: 1.2
  greeting:
    fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif"
    fontSize: "20px"
    fontWeight: 700
    lineHeight: 1.25
  brand:
    fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif"
    fontSize: "17px"
    fontWeight: 700
    lineHeight: 1.35
  card-title-desktop:
    fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif"
    fontSize: "16px"
    fontWeight: 600
    lineHeight: 1.4
  card-title-phone:
    fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif"
    fontSize: "15px"
    fontWeight: 600
    lineHeight: 1.35
  body:
    fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.5
  secondary:
    fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.45
  label:
    fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif"
    fontSize: "12px"
    fontWeight: 600
    lineHeight: 1.4
  micro:
    fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif"
    fontSize: "11px"
    fontWeight: 500
    lineHeight: 1.3
rounded:
  xs: "5px"
  sm: "10px"
  md: "12px"
  lg: "14px"
  tile: "16px"
  xl: "18px"
  2xl: "20px"
  3xl: "22px"
  full: "999px"
spacing:
  "1": "4px"
  "2": "8px"
  "3": "12px"
  "4": "16px"
  "5": "20px"
  "6": "24px"
components:
  button-primary:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.on-accent}"
    rounded: "{rounded.md}"
    height: "44px"
    padding: "0 18px"
  button-primary-hover:
    backgroundColor: "{colors.accent-hover}"
  button-primary-phone:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.on-accent}"
    rounded: "{rounded.lg}"
    height: "50px"
  button-secondary:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.md}"
    height: "44px"
  button-small:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.on-accent}"
    rounded: "{rounded.sm}"
    height: "36px"
    padding: "0 12px"
  button-danger:
    backgroundColor: "{colors.danger}"
    textColor: "{colors.on-danger}"
    rounded: "{rounded.md}"
    height: "44px"
  card:
    backgroundColor: "{colors.surface}"
    rounded: "{rounded.xl}"
    padding: "16px"
  card-desktop:
    backgroundColor: "{colors.surface}"
    rounded: "{rounded.2xl}"
    padding: "22px"
  stat-tile:
    backgroundColor: "{colors.surface}"
    rounded: "{rounded.tile}"
    padding: "12px"
  chip:
    backgroundColor: "{colors.success-soft}"
    textColor: "{colors.success-ink}"
    rounded: "{rounded.full}"
    padding: "3px 9px"
  input:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.sm}"
    height: "44px"
    padding: "0 12px"
  tab-bar:
    backgroundColor: "{colors.surface}"
    height: "64px"
  tab-active:
    backgroundColor: "{colors.accent-soft}"
    textColor: "{colors.link}"
    rounded: "{rounded.lg}"
  top-nav:
    backgroundColor: "{colors.surface}"
    height: "64px"
  top-nav-item-active:
    backgroundColor: "{colors.accent-soft}"
    textColor: "{colors.link}"
    rounded: "{rounded.sm}"
    padding: "8px 12px"
---

# Design System: Extra Duty

## Overview

**Creative North Star: "The Duty Board"**

Extra Duty is the board a deputy checks between shifts and a coordinator keeps on a second monitor: a calm, daylight surface of white cards on a cool gray canvas, one confident blue for everything you can act on, and status color only where a rule or a deadline needs attention. It is a working tool. The interface recedes so the facts (when, where, how much, who is short) read in one glance on a phone in a parking lot or on a desktop at home (deputies use both about equally), and in one scan across a coordinator's to-do list.

Density follows the device. Phone screens are roomy and stacked, with one primary action per card and a full-width tab bar pinned to the bottom edge, within thumb reach. Desktop screens are a centered 1240 px column with a top nav, two-column card layouts and compact 36 px row actions. Night mode is the same board in low light: deep blue-gray surfaces, lighter text, a brighter button blue and a pale link blue, so a deputy checking a detail at 2 AM is not blinded.

Source of truth: the approved mockups in `docs/mockups/project/` (Main, Dep-*, Dep-Home-Night, Coord-*, Vendor-Request, Invoice). Code: tokens in `src/ui/tokens.css`, components in `src/ui/components/`, shell in `src/ui/shell/` and `src/app/(app)/layout.tsx`.

**Key Characteristics:**
- Flat white cards with a 1 px line, no shadows except chrome that floats (the status note, the focused skip link).
- One accent blue for buttons, the active tab, links and filled staffing squares. Every text link is underlined.
- Status in soft pills and tinted cards: green open, amber warning, red danger, orange attention, blue info, purple coordinator.
- Inter throughout, 400 to 700, a tight product scale from 11 to 28 px.
- Line icons on a 24 px grid with a 1.8 stroke.
- Day and night themes from the same tokens; the device decides until the person chooses.

## Colors

Cool neutrals with a single saturated blue; status hues appear as soft fills with dark ink in day and as deep fills with light ink at night. Every token is `light-dark(day, night)` in `src/ui/tokens.css`; frontmatter keys ending in `-night` are the night values.

### Primary
- **Duty Blue** (accent): primary buttons, filled staffing squares, the progress bar's earned segment. Night uses a brighter Duty Blue so white button text keeps 4.6:1.
- **Duty Blue Ink** (link): links, the active tab and nav item text, info chips. At night it becomes the pale link blue, 8:1 on surfaces.
- **Duty Blue Wash** (accent-soft): the active tab and nav item background, date chips, info chips, avatars, the selected theme segment.
- **Signed-up Blue** (accent-muted): the "signed up" segment of a goal bar; decorative, always paired with a text count.
- **Open Spot Outline** (accent-outline): the outline of an open staffing square, 3.2:1 or better on surfaces.

### Neutral
- **Canvas** (canvas): page background behind cards.
- **Surface** (surface): cards, the top nav, the tab bar, inputs.
- **Subtle** (subtle): quiet panels inside a card (the policy acknowledgment box).
- **Sunken** (sunken): progress tracks, neutral chips, the dates that are not today.
- **Line** (line): card and secondary button borders. **Divider** (divider): rows inside a card.
- **Field** (field): input, select and textarea borders; 3:1 against surfaces so a field is findable without its label.
- **Ink** (ink): primary text. **Muted** (muted): secondary text, labels, inactive tabs; 5.2:1 or better everywhere it is used.

### Status
- **Open Green** (success-soft, success-ink, success-line): open spots, pay pills, met checks, paid.
- **Caution Amber** (warning-soft, warning-ink, warning-line, warning-strong): pending changes, a cap that is close, leave days, vendor on hold. Warning-strong draws the dashed backup square.
- **Stop Red** (danger-soft, danger-ink, danger-line, danger): officer safety, overdue, locked, cancel. Danger fills destructive buttons only.
- **Your Turn Orange** (attention-soft, attention-ink, attention-dot): spots left, "your turn", unfilled soon, unread dots.
- **Coordinator Purple** (coordinator-soft, coordinator-ink): the coordinator's turn in payment issues, and coordinator and admin avatars.

### Named Rules
**The One Blue Rule.** Blue means "you can act on this" or "you are here". Never use it for decoration, headings or icons at rest.

**The Status Means Something Rule.** A status color always names a state in words beside it ("1 open", "Overdue", "Pending shorter"). Color never carries a meaning alone.

**The No Hex Rule.** Components use semantic utilities (`bg-surface`, `text-muted`, `border-line`). Tailwind's own palette is switched off; a hex value in a component is a bug.

## Typography

**Display Font:** Inter (self-hosted through next/font; no request to Google at runtime)
**Body Font:** Inter (with ui-sans-serif, system-ui fallback)

**Character:** One neutral, highly legible sans for everything. Hierarchy comes from size and weight steps, not from a second family.

### Hierarchy
- **Page title** (700, 28 px desktop and 23 px phone, `text-3xl` and `text-2xl`): one `h1` per page.
- **Greeting** (700, 20 px, `text-xl`): the phone home header.
- **Stat** (700, 21 px, `text-stat`): numbers in stat tiles and summary cards, with the unit in 13 px muted 500.
- **Brand** (700, 17 px, `text-lg`): "Extra Duty" in the top nav.
- **Card title** (600, 15 px phone and 16 px desktop, `text-title` / `md:text-base`): `h2` in cards.
- **Body** (400, 14 px, `text-body`): default text, nav items, table cells. Running paragraphs stop at about 70 characters.
- **Secondary** (400, 13 px, `text-sm`): times, places and other second lines; field labels at 500.
- **Label** (600, 12 px, `text-xs`): chips, table headers, meta lines and hints.
- **Micro** (500, 11 px, `text-micro`): tab bar labels and the weekday on a date chip only.
- **Code** (system monospace: ui-monospace, SFMono-Regular, Menlo, Consolas; 13 to 14 px): API keys, request paths and code samples on the API access page only. Never for data or decoration.

### Named Rules
**The Fixed Scale Rule.** Only the eleven sizes above exist (Tailwind's defaults are cleared). No fluid type.

**The Tabular Money Rule.** Money, hours and counts use tabular figures (`data-numeric` or a table) so columns line up.

## Layout

- **Breakpoint:** one, at 768 px (`md`). Below it: phone layout and the bottom tab bar. At and above it: desktop layout and the top nav.
- **Phone:** 20 px side padding, 20 px top, sections stacked with 18 px gaps, cards 10 to 14 px apart, 28 px bottom padding.
- **Phone app shell:** under 768 px the signed-in shell is an app shell. The shell is fixed to the dynamic viewport height (`100dvh`) and never scrolls; the header and the tab bar are static flex children; only `main` scrolls, internally, with overscroll contained. The document therefore never scrolls under the chrome, so mobile browsers (Firefox Android in particular) keep their toolbar in place, and the last item of any list ends above the tab bar instead of behind it. At 768 px and up the page scrolls normally under the top nav.
- **Desktop:** content centered at 1240 px max with 24 px side padding and 26 px top. Two-column sections use flex-wrap with 520 px and 380 px bases so they stack on narrow windows.
- **Spacing:** Tailwind's 4 px step. Inside cards 12 to 14 px gaps; row padding 12 to 13 px vertical and 16 px horizontal; stat tiles in a 3-column grid with 10 px gaps.
- **Rhythm:** tight inside a group, generous between groups, more space above a heading than below it.

## Elevation & Depth

Flat by default. Depth comes from the canvas to surface step and the 1 px line, not from shadows.

### Shadow Vocabulary
- **Float** (`box-shadow: 0 6px 20px rgb(20 24 31 / 0.08)`, night `rgb(0 0 0 / 0.4)`, token `shadow-float`): the status note and the focused skip link, which float above content, and the maps menu.

### Named Rules
**The Only Float Rule.** Only chrome that floats above scrolling content casts a shadow. Cards, tiles and buttons never do.

## Shapes

Soft, friendly rectangles; radius grows with the size of the thing.

- **5 px** (`rounded-xs`): staffing squares, calendar day cells.
- **10 px** (`rounded-sm`): desktop nav items, compact buttons, inputs.
- **12 px** (`rounded-md`): standard buttons, radio rows, date chips, inner panels.
- **14 px** (`rounded-lg`): large phone buttons, the active tab's wash.
- **16 px** (`rounded-tile`): stat tiles.
- **18 px / 20 px** (`rounded-xl` / `md:rounded-2xl`): cards on phone / desktop.
- **22 px** (`rounded-3xl`): reserved; nothing uses it since the tab bar went flush.
- **Full** (`rounded-full`): chips, pills, avatars, icon buttons, unread dots.

Borders are 1 px; emphasis borders are 2 px (the sign-up card, a selected radio row, the locked-detail alert). No colored side stripes on cards or alerts; the one exception is the calendar entry's status stripe (see Calendar).

## Components

### Buttons
Tactile and plain: solid blue for the action, quiet outlined for the rest.
- **Primary** (`Button` variant primary): accent fill, white 600 text. Hover darkens to accent-hover.
- **Secondary**: surface fill, 1 px line, ink text. Hover fills subtle.
- **Danger**: danger fill, white text. Only for destructive actions (Cancel detail).
- **Sizes:** `sm` 36 px, 10 px radius, 13 px text, for dense desktop rows (44 px on touch screens); `md` 44 px, 12 px radius, 14 px; `lg` 50 px, 14 px radius, 16 px, the one main action on a phone screen.
- **States:** focus shows the focus ring; disabled and busy drop to 55 percent opacity and set `aria-busy` while running. `ButtonLink` is a link styled as a button, for navigation.

### Chips
- **Style** (`Chip`): full pill, 3 px by 9 px, 12 px 600, soft fill with matching ink. Tones: success, warning, danger, attention, info, coordinator, neutral.
- **Filter chips** (planned, Jobs and Payments screens): 32 to 34 px tall, full radius, 1 px line, surface fill; selected is ink fill with surface text and 600 weight. They are toggle buttons with `aria-pressed`.

### Cards / Containers
- **Corner Style:** 18 px phone, 20 px desktop.
- **Background:** surface, 1 px line; tinted tones for alerts (danger: danger-soft with danger-line; warning: warning-soft with warning-line); accent tone adds a 2 px accent border for the card that holds the main action.
- **Shadow Strategy:** none (see Elevation).
- **Internal Padding:** 16 px phone, 22 px desktop; `pad={false}` for edge-to-edge list rows, which use 13 by 16 px and a divider between rows.
- **Card title:** `CardTitle`, an `h2`. A count badge sits after it: 22 px tall, full radius, accent-soft with link text.
- **Stat tile** (`StatTile`): 12 px padding, 16 px radius, 12 px muted label, 21 px bold value with a muted unit ("6 / 16 h"). The warning tone fills amber when a cap is close.

### Inputs / Fields
- **Style** (`FormField` with `Input`, `Select`, `TextArea`): label above in 13 px 500 muted; 44 px control, 10 px radius, 1 px field border, surface fill, 14 px text; hint below in 12 px muted.
- **Focus:** border and a 2 px outline in the focus color.
- **Error:** border turns danger, a 12 px 500 danger-ink message below, `aria-invalid` and `aria-describedby` wired by `FormField`.
- **Disabled:** subtle fill, muted text.
- **Choices:** radio rows are 12 px padded, 12 px radius, 1 px line; the selected row gets a 2 px accent border. The theme control is a segmented radiogroup (System, Day, Night) built on native radios. Signed in, a choice is kept only after the profile saves it; on failure the page returns to the previous theme and a danger note says so (inline on Profile, a small floating note under the header control with a Dismiss button). The browser chrome color (`theme-color`) follows the chosen theme.
- **Switches:** a `button` with `role="switch"` and `aria-checked`, a 30 by 18 px track (field color off, accent on) and a visible text label (Training mode, Alert me if it opens).

### Navigation
- **Top nav (768 px and up):** surface bar with a bottom line, min 64 px tall, content at 1240 px. Brand "Extra Duty" at 17 px 700, then the role's sections as 14 px 500 muted items (8 by 12 px, 10 px radius). The current item is accent-soft with link text at 600 and `aria-current="page"`. Right side: the compact theme control and the avatar (36 px, initials; coordinator purple for coordinators and admins, accent for others), which opens Profile.
- **Tab bar (under 768 px):** a full-width bar pinned flush to the bottom edge: no side or bottom margin, no radius, no shadow. Surface fill with a 1 px top line, 64 px tall plus bottom padding for the safe-area inset (the home indicator sits on the bar's own surface, not on content). It is a static child of the app shell, so it never overlaps content. Up to five tabs share the width equally: 22 px icon over an 11 px label, at least 58 by 44 px; the current tab has an accent-soft wash (14 px radius) with link text at 600.
- **Sections by role:** deputies get Home, Details, Map, Billing, Profile (all five on the phone). Coordinators and admins get To-do, Details, Calendar, Vendors, Payments, Reports, Messages, Management; the phone shows To-do, Details, Calendar, Messages and More. Vendors get My details, Request a detail, Invoices, Locations, Contracts; the phone shows My details, Request, Invoices, Locations and More. More lists the remaining sections plus Profile; deputies have no More page (it sends them Home). The current tab is worked out from all of the role's sections, so a section that lives under More marks More, never a parent tab such as To-do.
- **Skip link:** "Skip to content" is the first focusable element on every signed-in page.

### Links
Links must read as links without relying on color.
- **Text links** are underlined at rest in both themes: 1 px, `text-underline-offset: 3px`, the underline in `currentColor` at about 50 percent. On hover and keyboard focus the underline goes to full opacity and 2 px. This is the base style of every `a`; nothing opts out of it except the cases below.
- **Standalone action links** (Open in Maps, Directions, View invoice, Open the deputy view) are `ActionLink`: underlined text with a trailing icon (chevron for in-app, external for another site), 13 px 600, and a 44 px tall hit area. Back links keep their leading chevron.
- **Phone numbers and email addresses** are `tel:` and `mailto:` links (`PhoneLink`, `EmailLinks`) with a leading phone or mail icon and the full value (###-###-####, never shortened). A saved number that is not a full US number shows as typed, not as a link; staff see a "Check this number" hint beside it.
- **Disclosure toggles** ("9 other checks passed", "Show 3 more") are buttons, not links: tertiary style (no fill, no border, link-colored 600 text, 44 px tall) with a chevron that turns when open and `aria-expanded`.
- **Button-styled links** (`ButtonLink`) stay buttons: no underline. Nav items (tab bar, top nav, section tabs, More rows, the brand and avatar) and row or card links whose whole surface is the target (a detail row, a calendar entry) are not text links either; a card link underlines its title instead.
- A unit check renders the link components and an e2e check walks every anchor in `main` and fails on one without an underline that is not a button-styled link, a nav item or a card link.

### Agency logo
`AgencyLogo` shows the uploaded logo, always contained (never cropped to a circle, never stretched). Uploads (PNG, SVG, JPG, WebP) are redrawn as a PNG at most 512 px a side with uniform margins trimmed; the size and whether the logo has any transparency are kept in settings. Logos about 1.3:1 and wider (`WIDE_RATIO` 1.3 in `src/lib/logo-fit.ts`) take the wide slot, where they are as tall as the square slot and as wide as their ratio needs up to the cap: sign-in 88 tall (cap 240), header 40 tall (cap 96), invoice PDF 56 pt tall (cap 150 pt). Square and tall logos fit inside the square slot. By day the logo sits on white. At night only a logo with no transparency (a JPG, or a PNG on an opaque background) keeps the light `logo-plate`; a transparent logo uses `logo-clear` and sits directly on the dark surface. White artwork on the white day header stays invisible (accepted by the owner). The agency name is printed beside it, so the image is decorative.

### Address field
`AddressField` looks the address up on OpenStreetMap Nominatim when the person leaves it (through `/api/v1/geocode`: one request a second for the whole server, cached). A match that reads the same shows "Found on the map."; a different one shows "Did you mean" with Use suggested and Keep as entered; no match, a failed lookup or Keep as entered shows a warning "Not verified" chip. "Address search by OpenStreetMap" credits the service. Vendor locations and officer safety addresses add `PinPicker`, a small map whose pin can be dragged, tapped into place or moved with the arrow keys; a hand-placed pin overrides the lookup. Nothing here ever blocks saving.

### Site contacts
A vendor's site contacts are kept on the vendor record and the vendor's Locations page (add, edit, deactivate; never deleted). On the detail forms "Site contact" is a dropdown of the active contacts plus "Add a new contact"; choosing one fills Contact phone, which stays editable for that detail only.

### Addresses and maps
Every address link (detail page, cards, calendar entries, the map popup, vendor locations) is `MapsLink`. Tapping "Open in Maps" opens a small menu (surface, 1 px line, 12 px radius, float shadow) with Google Maps, Apple Maps and OpenStreetMap, each a real link that opens in a new tab and uses the pinned coordinates when there are any, else the address text. "Remember my choice" saves the person's preferred maps app to Profile (default: ask each time); after that the link opens that app directly and a small "Other maps" button beside it opens the menu. No map API keys.

### Staffing Grid (signature)
`StaffingGrid` draws one labeled row per position: a 110 px muted name, then 22 px squares with 6 px gaps that wrap. Solid accent squares are filled spots, accent-outline squares (2 px) are open spots, dashed warning-strong squares (2 px) are backups. The grid is one `role="img"` whose label is the summary and names every position with open spots ("17 of 17 spots filled, 2 backups waiting"; "15 of 17 spots filled: Deputy Sheriff 2 open. 2 backups waiting"). Negative or fractional counts draw as zero, and rows take a stable `id` when two positions share a name. The legend line below reads "Solid: filled. Outline: open. Dashed: backup." The roster table carries the names.

### Pay Label (signature)
`PayLabel` is the only way any screen shows a detail's pay: total and hourly rate together, "$280 at $70/hr" (cents shown only when not whole, "$506.25 at $72.50/hr"). When a position pays a differential (an Incident Commander +$25/hr), lists show the range "$280 to $380 at $70 to $95/hr"; a person on the detail sees their own position's pay. The pill variant (success-soft, 14 px 600 total, 12 px 500 rate) goes on lists, cards and map pins; the plain variant (600 total, muted rate) goes inside summaries and sentences. Never print a rate or a total alone for a detail. One exception: the "Rates outside the agency range" warning (to-do row chip, "$95 an hour") prints the rate alone, because the rate itself is what it flags; the detail page beside it still shows the full PayLabel.

### Calendar
The agency Calendar (every detail the person may see; vendors use their portal) and the coordinator Details list share one filter panel.
- **Filter panel** (`FilterPanel`): a 272 px left column on desktop, a full-width Filters button that opens the same panel inline on phones. Search, job number, My details only, status (open, filled, not released, past, canceled, and vendor requests for staff), vendor, vendor type, detail type, location (collapsible checkbox groups that open when something is picked), person signed up, Remember my filters, then Apply and Reset. Filters are the person's own: they live in the address bar and, when remembered, on that person's account only.
- **Month grid:** desktop cells are 144 px tall with the day number (today in a Duty Blue circle on an accent-soft cell, `aria-current="date"`), "N details" in micro text, and a scrolling list of entries "7:00 AM Vendor name" (title on hover). Phone cells show the day and a count pill; the cell opens that day's list.
- **Status stripe:** a 4 px rounded stripe at the left of each entry (6 px in lists), steady, never animated: open `cal-open` green, filled `cal-filled` red, not released or held `cal-unreleased` amber, past `cal-past` dark blue-gray, vendor request coordinator purple, canceled field gray with the text struck through. Each stripe is 3:1 or better on surfaces in both themes, and every entry also carries its status in words (a chip in lists, screen-reader text in the grid). A legend ("Color key") sits under the calendar. "(you)" marks the viewer's own details.
- **Bulk edit:** staff lists (Details, Calendar list view) put a 44 px checkbox before each row and "Edit selected" above; the edit opens inline with a before and after preview and saves every detail or none.

### Check List
`CheckList` shows each rule with a check (success-ink) or a cross (danger-ink), the rule in words, an optional right-aligned fact ("8 / 16 h"), and "Met" or "Not met" for screen readers. Used for sign-up eligibility and caps.

### Tables
`Table` sits on a card: 12 px 600 muted headers, 12 by 14 px cells, a divider between rows, numbers right-aligned in tabular figures. Wide tables scroll inside the card and only then become a focusable, labeled region; the page never scrolls sideways.

### Notices
`Notice` is a short tinted message inside a card: an info icon and 13 px text on a soft fill (warning, danger, success, info), 12 px radius, 10 by 12 px padding. Form results sit in an always-present `role="status"` region so each new message is announced.

### Signed-out pages
`AuthShell` frames sign-in, code entry, invite acceptance and password resets (mockup Dep-SignIn):
- A centered column, phone width on every screen (440 px max), 56 px from the top (80 px on desktop).
- The agency mark: the agency logo in its slot (see Agency logo), or a 76 px circle with the agency's initials when there is none.
- "Extra Duty" at 23 px 700 over the agency name from settings in muted 14 px.
- One 20 px-radius card holding the page's `h1` (20 px 700), then 48 px fields (`Input size="lg"`) and a full-width 50 px primary button.
- A muted 12 px line under the card.
- Sign-in adds "Forgot password?" over the amber inactivity notice.
- The code page uses one 56 px numeric one-time-code field (`size="code"`); the staging code shows as an amber notice.

### Empty States
`EmptyState` says what will appear and how to get it, with an optional action: a 15 to 16 px 600 title and a muted line of at most 48 characters.

### Icons
Line icons on a 24 px grid, 1.8 stroke, round caps and joins, `currentColor` (`src/ui/icons.tsx`). 20 px in buttons and headers, 22 px in the tab bar, 18 px in lists. Decorative (`aria-hidden`); the control carries the name.

### Motion
Minimal and state-only: color and background transitions at 150 ms on hover and selection. No entrance animations, no page-load choreography. `prefers-reduced-motion: reduce` turns transitions and animations off.

## Do's and Don'ts

### Do:
- **Do** use the semantic utilities from `src/ui/tokens.css` and the components in `src/ui/components/`.
- **Do** show pay only through `PayLabel`.
- **Do** keep one primary button per card on phones, 50 px tall and full width when it is the screen's main action.
- **Do** pair every status color with words.
- **Do** tell people when an action did not happen (a failed sign-out or save) and leave them where they were.
- **Do** check every screen at 390 by 844 and 1280 by 900 in day and night, with an axe pass and no serious violations.

### Don't:
- **Don't** hard-code a hex value or use a Tailwind palette color in a component.
- **Don't** add shadows to cards, tiles or buttons.
- **Don't** add a second accent color or use blue for decoration.
- **Don't** use a colored left or right border stripe on cards or alerts.
- **Don't** use a modal where an inline section or a page works.
- **Don't** add a kicker or eyebrow label above a heading.

### Copy
- Plain, professional language. Say what happened and what to do next ("Confirm payment on 1 invoice to sign up again.").
- No em dashes, no emojis, no exclamation marks.
- Headings are sentence case noun phrases ("Open for you", "Invoices to review").
- Controls name their action ("Review and send invoice", "Cancel detail"), never "Submit" or "OK".
- Times as "2:00 to 6:00 PM", dates as "Tue, Dec 1", money as "$1,087.50".

### Accessibility
- WCAG 2.2 AA contrast in both themes: text 4.5:1, large text and UI boundaries (fields, open squares, focus ring) 3:1. The mockups' lighter open-square outline and field border were darkened to pass.
- Touch targets at least 44 by 44 px on phones; compact desktop controls grow to 44 px on touch screens (`pointer-coarse`).
- Visible focus everywhere: a 2 px focus-color outline with a 2 px offset.
- Real buttons and links, and links underlined (see Links); switches use `role="switch"` and `aria-checked`; the staffing grid is `role="img"` with a summary label; the current nav item has `aria-current="page"`.
- One `h1` per page; landmarks: header, nav "Main", main.
