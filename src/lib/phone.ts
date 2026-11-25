/** US phone numbers, shown and stored as ###-###-####. Shared by the field and the domain rule. */

/** Every digit typed, without a leading US country code when there are eleven ("+1 555 555 5555"). */
export function phoneDigits(raw: string | null | undefined): string {
  const d = (raw ?? "").replace(/\D/g, "");
  return d.length === 11 && d[0] === "1" ? d.slice(1) : d;
}

/** Up to ten digits with dashes after the third and sixth, as far as they go: "555", "555-5", "555-555-5555". */
export function formatPhone(digits: string): string {
  const d = digits.replace(/\D/g, "").slice(0, 10);
  if (d.length <= 3) return d;
  if (d.length <= 6) return `${d.slice(0, 3)}-${d.slice(3)}`;
  return `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}`;
}

/** The saved form of a complete number, or null when it is not 10 US digits. */
export function normalizePhone(raw: string): string | null {
  const d = phoneDigits(raw);
  return d.length === 10 ? formatPhone(d) : null;
}

const isDigit = (c: string) => c >= "0" && c <= "9";

/**
 * Reformats the field after an edit. `prev` is the value before, `next` what the browser produced and `cursor`
 * its caret. The caret stays after the same digit; a backspace over a dash deletes the digit before it, so the
 * dash cannot trap the caret. Pasted numbers in any format become ###-###-####.
 */
export function formatPhoneInput(prev: string, next: string, cursor: number): { value: string; cursor: number } {
  let raw = next;
  let cur = cursor;
  const onlyDashGone = next.length < prev.length && next.replace(/\D/g, "") === prev.replace(/\D/g, "");
  if (onlyDashGone) {
    let i = cur - 1;
    while (i >= 0 && !isDigit(raw[i])) i--;
    if (i >= 0) {
      raw = raw.slice(0, i) + raw.slice(i + 1);
      cur = i;
    }
  }
  let all = raw.replace(/\D/g, "");
  let n = raw.slice(0, cur).replace(/\D/g, "").length;
  if (all.length === 11 && all[0] === "1") {
    all = all.slice(1);
    n = Math.max(0, n - 1);
  }
  all = all.slice(0, 10);
  n = Math.min(n, all.length);
  const value = formatPhone(all);
  let pos = 0;
  for (let i = 0, seen = 0; i < value.length && n > 0; i++) {
    if (isDigit(value[i]) && ++seen === n) {
      pos = i + 1;
      break;
    }
  }
  return { value, cursor: pos };
}
