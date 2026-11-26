/** The longest email address accepted, in characters. */
const MAX_EMAIL_LENGTH = 254;

/**
 * A plausible email address: one "@" with text before it, and a domain with a dot that has text on both sides. No
 * whitespace. Checked by splitting rather than one regex, so a long input cannot make it slow.
 */
export function isEmail(value: string): boolean {
  if (value.length > MAX_EMAIL_LENGTH || /\s/.test(value)) return false;
  const parts = value.split("@");
  if (parts.length !== 2 || parts[0] === "") return false;
  const domain = parts[1];
  const dot = domain.indexOf(".", 1);
  return dot !== -1 && dot < domain.length - 1;
}
