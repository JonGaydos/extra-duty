import { describe, expect, test } from "vitest";
import { agencyInstant } from "@/domain/time/agency-time";
import { ValidationError } from "@/domain/errors";
import { CalendarLimitError, MAX_BUSY_ROWS, MAX_TITLE_LENGTH, bestPlacement, dutyIntervals, fitsSchedule, parseIcsBusy, validateBuffer, type ScheduleException, type WorkSchedule } from "@/domain/planning/schedule";

const at = (m: number, d: number, h: number, min = 0) => agencyInstant(2026, m, d, h, min);

const base: WorkSchedule = {
  kind: "weekly",
  weekdays: null,
  cycle: null,
  anchorDate: "2026-11-02",
  shiftStart: "08:00",
  shiftEnd: "17:00",
  bufferMinutes: 0,
  active: true,
};
const weekly = (over: Partial<WorkSchedule> = {}): WorkSchedule => ({ ...base, weekdays: [1, 2, 3, 4, 5], ...over });
const rotation = (over: Partial<WorkSchedule> = {}): WorkSchedule => ({
  ...base,
  kind: "rotation",
  cycle: "11001110011000",
  shiftStart: "18:00",
  shiftEnd: "06:00",
  ...over,
});
const off = (date: string): ScheduleException => ({ date, kind: "off", shiftStart: null, shiftEnd: null });
const extra = (date: string, s: string, e: string): ScheduleException => ({ date, kind: "extra", shiftStart: s, shiftEnd: e });

describe("dutyIntervals", () => {
  test("a 2-2-3 rotation works Nov 2-3, 6-8 and is off Nov 4-5; overnight shifts end the next day", () => {
    const out = dutyIntervals([rotation()], [], at(11, 2, 0), at(11, 10, 0));
    expect(out.map((i) => i.startAt.toISOString())).toEqual([
      at(11, 2, 18).toISOString(),
      at(11, 3, 18).toISOString(),
      at(11, 6, 18).toISOString(),
      at(11, 7, 18).toISOString(),
      at(11, 8, 18).toISOString(),
    ]);
    expect(out[0].endAt.toISOString()).toBe(at(11, 3, 6).toISOString());
  });

  test("an overnight shift that began before the window still counts", () => {
    const out = dutyIntervals([rotation()], [], at(11, 3, 0), at(11, 3, 12));
    expect(out).toHaveLength(1);
    expect(out[0].endAt.toISOString()).toBe(at(11, 3, 6).toISOString());
  });

  test("the rotation repeats after the cycle and counts days before the anchor", () => {
    const out = dutyIntervals([rotation()], [], at(11, 16, 0), at(11, 18, 0));
    expect(out.map((i) => i.startAt.toISOString())).toEqual([at(11, 16, 18).toISOString(), at(11, 17, 18).toISOString()]);
    // Oct 29 is 4 days before the anchor: index 10 of the cycle, a work day; Oct 30 is index 11, off.
    const before = dutyIntervals([rotation()], [], at(10, 29, 7), at(10, 31, 0));
    expect(before.map((i) => i.startAt.toISOString())).toEqual([at(10, 29, 18).toISOString()]);
  });

  test("weekly Monday to Friday has nothing on Saturday", () => {
    const out = dutyIntervals([weekly()], [], at(11, 7, 0), at(11, 8, 0));
    expect(out).toEqual([]);
    expect(dutyIntervals([weekly()], [], at(11, 6, 0), at(11, 7, 0))).toHaveLength(1);
  });

  test("an off exception removes that day and an extra exception adds a shift", () => {
    const out = dutyIntervals([weekly()], [off("2026-11-04"), extra("2026-11-07", "10:00", "14:00")], at(11, 2, 0), at(11, 9, 0));
    const days = out.map((i) => i.startAt.toISOString());
    expect(days).not.toContain(at(11, 4, 8).toISOString());
    expect(days).toContain(at(11, 7, 10).toISOString());
    expect(out).toHaveLength(5);
  });

  test("the buffer widens both sides; an inactive schedule gives nothing", () => {
    const [i] = dutyIntervals([weekly({ bufferMinutes: 45 })], [], at(11, 2, 0), at(11, 3, 0));
    expect(i.startAt.toISOString()).toBe(at(11, 2, 7, 15).toISOString());
    expect(i.endAt.toISOString()).toBe(at(11, 2, 17, 45).toISOString());
    expect(dutyIntervals([weekly({ active: false })], [], at(11, 2, 0), at(11, 3, 0))).toEqual([]);
  });

  test("a buffer outside none, 15, 30, 45, 60 is rejected", () => {
    expect(() => validateBuffer(20)).toThrow(ValidationError);
    for (const b of [0, 15, 30, 45, 60]) expect(() => validateBuffer(b)).not.toThrow();
  });
});

describe("dutyIntervals extras and DST", () => {
  const everyDay = (over: Partial<WorkSchedule> = {}) => weekly({ weekdays: [0, 1, 2, 3, 4, 5, 6], shiftStart: "18:00", shiftEnd: "06:00", ...over });
  const hours = (i: { startAt: Date; endAt: Date }) => (i.endAt.getTime() - i.startAt.getTime()) / 3_600_000;

  test("an overnight shift is 13 hours on the fall-back night and 11 on the spring-forward night", () => {
    // Fall back: Sunday Nov 1, 2026, 2:00 AM. The Oct 31 shift ends 6:00 AM Nov 1.
    const fall = dutyIntervals([everyDay()], [], at(10, 31, 12), at(10, 31, 23));
    expect(fall).toHaveLength(1);
    expect(hours(fall[0])).toBe(13);
    // Spring forward: Sunday Mar 8, 2026, 2:00 AM. The Mar 7 shift ends 6:00 AM Mar 8.
    const spring = dutyIntervals([everyDay()], [], agencyInstant(2026, 3, 7, 12, 0), agencyInstant(2026, 3, 7, 23, 0));
    expect(spring).toHaveLength(1);
    expect(hours(spring[0])).toBe(11);
  });

  test("a rotation keeps its days across the DST change", () => {
    const out = dutyIntervals([rotation({ anchorDate: "2026-10-30" })], [], at(10, 30, 0), at(11, 3, 0));
    expect(out.map((i) => i.startAt.toISOString())).toEqual([at(10, 30, 18).toISOString(), at(10, 31, 18).toISOString()]);
  });

  test("extra shifts apply with no active schedule and with no schedule at all", () => {
    const e = [extra("2026-11-07", "10:00", "14:00")];
    expect(dutyIntervals([weekly({ active: false })], e, at(11, 7, 0), at(11, 8, 0))).toHaveLength(1);
    expect(dutyIntervals([], e, at(11, 7, 0), at(11, 8, 0))).toEqual([{ startAt: at(11, 7, 10), endAt: at(11, 7, 14) }]);
    const [i] = dutyIntervals([weekly({ active: false, bufferMinutes: 30 })], e, at(11, 7, 0), at(11, 8, 0));
    expect(i.startAt.toISOString()).toBe(at(11, 7, 9, 30).toISOString());
  });
});

describe("bestPlacement and fitsSchedule", () => {
  const shiftEnds5 = (buffer: number) => dutyIntervals([weekly({ bufferMinutes: buffer })], [], at(11, 2, 0), at(11, 3, 0));
  const job = (h: number, min: number, endH = 23) => ({ startAt: at(11, 2, h, min), endAt: at(11, 2, endH) });

  test("a 1-hour buffer blocks a 5:30 PM start after a 5:00 PM shift end; 15 minutes allows it", () => {
    expect(fitsSchedule(job(17, 30), shiftEnds5(60))).toBe(false);
    expect(fitsSchedule(job(17, 30), shiftEnds5(15))).toBe(true);
  });

  test("the default times win when they fit", () => {
    expect(bestPlacement(job(18, 0), shiftEnds5(0))).toEqual({ startAt: at(11, 2, 18), endAt: at(11, 2, 23) });
  });

  test("a flex detail moves to the earliest fit in 15-minute steps at the default length", () => {
    const busy = [{ startAt: at(11, 2, 8), endAt: at(11, 2, 17, 45) }];
    const flexJob = { startAt: at(11, 2, 17), endAt: at(11, 2, 23), flex: { earliestStartAt: at(11, 2, 17), latestEndAt: at(11, 3, 0), allowShorter: false } };
    expect(bestPlacement(flexJob, busy)).toEqual({ startAt: at(11, 2, 17, 45), endAt: at(11, 2, 23, 45) });
  });

  test("no placement when the flex range cannot hold the detail", () => {
    const busy = [{ startAt: at(11, 2, 8), endAt: at(11, 2, 19) }];
    const flexJob = { startAt: at(11, 2, 17), endAt: at(11, 2, 23), flex: { earliestStartAt: at(11, 2, 17), latestEndAt: at(11, 3, 0), allowShorter: false } };
    expect(bestPlacement(flexJob, busy)).toBeNull();
  });

  test("touching intervals do not overlap", () => {
    expect(fitsSchedule({ startAt: at(11, 2, 17), endAt: at(11, 2, 20) }, shiftEnds5(0))).toBe(true);
  });
});

const ICS = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Test//EN
BEGIN:VTIMEZONE
TZID:America/Chicago
BEGIN:STANDARD
DTSTART:20071104T020000
RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU
TZOFFSETFROM:-0500
TZOFFSETTO:-0600
TZNAME:CST
END:STANDARD
BEGIN:DAYLIGHT
DTSTART:20070311T020000
RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU
TZOFFSETFROM:-0600
TZOFFSETTO:-0500
TZNAME:CDT
END:DAYLIGHT
END:VTIMEZONE
BEGIN:VEVENT
UID:weekly@test
DTSTART;TZID=America/Chicago:20261102T090000
DTEND;TZID=America/Chicago:20261102T100000
RRULE:FREQ=WEEKLY;BYDAY=MO;COUNT=4
SUMMARY:Staff meeting
TRANSP:OPAQUE
END:VEVENT
BEGIN:VEVENT
UID:free@test
DTSTART;TZID=America/Chicago:20261104T130000
DTEND;TZID=America/Chicago:20261104T140000
SUMMARY:Lunch hold
TRANSP:TRANSPARENT
X-MICROSOFT-CDO-BUSYSTATUS:FREE
END:VEVENT
BEGIN:VEVENT
UID:allday@test
DTSTART;VALUE=DATE:20261105
DTEND;VALUE=DATE:20261106
SUMMARY:Court
TRANSP:OPAQUE
END:VEVENT
BEGIN:VEVENT
UID:cancelled@test
DTSTART:20261106T150000Z
DTEND:20261106T160000Z
SUMMARY:Cancelled thing
STATUS:CANCELLED
END:VEVENT
END:VCALENDAR`.replace(/\n/g, "\r\n");

describe("parseIcsBusy", () => {
  test("expands the recurring meeting, skips Free and cancelled, and blocks the all-day date", () => {
    const out = parseIcsBusy(ICS, at(11, 1, 0), at(11, 20, 0));
    expect(out.map((b) => [b.title, b.startAt.toISOString(), b.endAt.toISOString()])).toEqual([
      ["Staff meeting", at(11, 2, 9).toISOString(), at(11, 2, 10).toISOString()],
      ["Court", at(11, 5, 0).toISOString(), at(11, 6, 0).toISOString()],
      ["Staff meeting", at(11, 9, 9).toISOString(), at(11, 9, 10).toISOString()],
      ["Staff meeting", at(11, 16, 9).toISOString(), at(11, 16, 10).toISOString()],
    ]);
  });

  test("the window limits the result", () => {
    const out = parseIcsBusy(ICS, at(11, 8, 0), at(11, 10, 0));
    expect(out).toHaveLength(1);
    expect(out[0].startAt.toISOString()).toBe(at(11, 9, 9).toISOString());
  });

  test("rejects text that is not a calendar", () => {
    expect(() => parseIcsBusy("hello", at(11, 1, 0), at(11, 20, 0))).toThrow(ValidationError);
  });
});

const wrap = (events: string, extra = "") => `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//T//EN\r\n${extra}${events}END:VCALENDAR`;
const event = (lines: string[]) => `BEGIN:VEVENT\r\n${lines.join("\r\n")}\r\nEND:VEVENT\r\n`;

describe("parseIcsBusy bounds and tolerance", () => {
  test("a daily series that started in 2015 still yields busy time in the window", () => {
    const ics = wrap(event(["UID:old@t", "DTSTART:20150101T150000Z", "DTEND:20150101T153000Z", "RRULE:FREQ=DAILY", "SUMMARY:Standup"]));
    const out = parseIcsBusy(ics, at(11, 2, 0), at(11, 5, 0));
    expect(out.map((b) => b.startAt.toISOString())).toEqual(["2026-11-02T15:00:00.000Z", "2026-11-03T15:00:00.000Z", "2026-11-04T15:00:00.000Z"]);
  });

  test("the row cap is enforced", () => {
    const events = Array.from({ length: MAX_BUSY_ROWS + 1 }, (_, i) => event([`UID:e${i}@t`, "DTSTART:20261201T150000Z", "DTEND:20261201T151500Z", `SUMMARY:E${i}`])).join("");
    expect(() => parseIcsBusy(wrap(events), at(11, 1, 0), at(12, 20, 0))).toThrow(CalendarLimitError);
    const ok = Array.from({ length: MAX_BUSY_ROWS }, (_, i) => event([`UID:e${i}@t`, "DTSTART:20261201T150000Z", "DTEND:20261201T151500Z", `SUMMARY:E${i}`])).join("");
    expect(parseIcsBusy(wrap(ok), at(11, 1, 0), at(12, 20, 0))).toHaveLength(MAX_BUSY_ROWS);
  });

  test("many recurring series share one expansion budget", () => {
    const events = Array.from({ length: 200 }, (_, i) => event([`UID:m${i}@t`, "DTSTART:20200101T000000Z", "DTEND:20200101T000100Z", "RRULE:FREQ=MINUTELY", `SUMMARY:M${i}`])).join("");
    const started = Date.now();
    expect(() => parseIcsBusy(wrap(events), at(11, 1, 0), at(11, 2, 0))).toThrow(CalendarLimitError);
    expect(Date.now() - started).toBeLessThan(5000);
  });

  test("an event with no start is skipped, not fatal", () => {
    const ics = wrap(event(["UID:bad@t", "SUMMARY:No start"]) + event(["UID:ok@t", "DTSTART:20261104T150000Z", "DTEND:20261104T160000Z", "SUMMARY:Fine"]));
    expect(parseIcsBusy(ics, at(11, 1, 0), at(11, 20, 0)).map((b) => b.title)).toEqual(["Fine"]);
  });

  test("an IANA TZID without a VTIMEZONE block is read in that zone", () => {
    const ics = wrap(event(["UID:ny@t", "DTSTART;TZID=America/New_York:20261104T100000", "DTEND;TZID=America/New_York:20261104T110000", "SUMMARY:East"]));
    const [b] = parseIcsBusy(ics, at(11, 1, 0), at(11, 20, 0));
    expect(b.startAt.toISOString()).toBe("2026-11-04T15:00:00.000Z");
    expect(b.endAt.toISOString()).toBe("2026-11-04T16:00:00.000Z");
  });

  test("an unknown TZID falls back to agency time", () => {
    const ics = wrap(event(["UID:x@t", "DTSTART;TZID=Nowhere Standard Time:20261104T100000", "DTEND;TZID=Nowhere Standard Time:20261104T110000", "SUMMARY:Odd"]));
    const [b] = parseIcsBusy(ics, at(11, 1, 0), at(11, 20, 0));
    expect(b.startAt.toISOString()).toBe(at(11, 4, 10).toISOString());
  });
});

describe("parseIcsBusy scale and exceptions", () => {
  test("10,000 past single events plus one in the window parse within the budget", () => {
    const past = Array.from({ length: 10_000 }, (_, i) => event([`UID:p${i}@t`, "DTSTART:20200105T150000Z", "DTEND:20200105T160000Z", `SUMMARY:P${i}`])).join("");
    const now = event(["UID:now@t", "DTSTART:20261104T150000Z", "DTEND:20261104T160000Z", "SUMMARY:Current"]);
    const started = Date.now();
    const out = parseIcsBusy(wrap(past + now), at(11, 1, 0), at(11, 20, 0));
    expect(Date.now() - started).toBeLessThan(3000);
    expect(out.map((b) => b.title)).toEqual(["Current"]);
  });

  test("an exception with a different UID does not replace another series' occurrence", () => {
    const master = event(["UID:series-a@t", "DTSTART:20261102T150000Z", "DTEND:20261102T160000Z", "RRULE:FREQ=DAILY;COUNT=3", "SUMMARY:Series A"]);
    const stranger = event(["UID:series-b@t", "RECURRENCE-ID:20261103T150000Z", "DTSTART:20261103T200000Z", "DTEND:20261103T210000Z", "SUMMARY:Stranger"]);
    const out = parseIcsBusy(wrap(master + stranger), at(11, 1, 0), at(11, 20, 0));
    expect(out.map((b) => [b.title, b.startAt.toISOString()])).toEqual([
      ["Series A", "2026-11-02T15:00:00.000Z"],
      ["Series A", "2026-11-03T15:00:00.000Z"],
      ["Series A", "2026-11-04T15:00:00.000Z"],
    ]);
  });

  test("an exception with the same UID still moves its occurrence", () => {
    const master = event(["UID:series-a@t", "DTSTART:20261102T150000Z", "DTEND:20261102T160000Z", "RRULE:FREQ=DAILY;COUNT=3", "SUMMARY:Series A"]);
    const moved = event(["UID:series-a@t", "RECURRENCE-ID:20261103T150000Z", "DTSTART:20261103T200000Z", "DTEND:20261103T210000Z", "SUMMARY:Moved"]);
    const out = parseIcsBusy(wrap(master + moved), at(11, 1, 0), at(11, 20, 0));
    expect(out.map((b) => [b.title, b.startAt.toISOString()])).toEqual([
      ["Series A", "2026-11-02T15:00:00.000Z"],
      ["Series A", "2026-11-04T15:00:00.000Z"],
      ["Moved", "2026-11-03T20:00:00.000Z"],
    ].sort((a, b) => a[1].localeCompare(b[1])));
  });

  test("NUL characters are stripped and titles are capped", () => {
    const long = "x".repeat(MAX_TITLE_LENGTH + 100);
    const ics = wrap(event(["UID:a@t", "DTSTART:20261104T150000Z", "DTEND:20261104T160000Z", "SUMMARY:Bad\u0000Title"]) + event(["UID:b@t", "DTSTART:20261105T150000Z", "DTEND:20261105T160000Z", `SUMMARY:${long}`]));
    const out = parseIcsBusy(ics, at(11, 1, 0), at(11, 20, 0));
    expect(out[0].title).toBe("BadTitle");
    expect(out[1].title).toHaveLength(MAX_TITLE_LENGTH);
  });
});
