/** A text field from submitted form data: "" when it is missing or holds a file instead of text. */
export function formText(form: FormData, name: string): string {
  const v = form.get(name);
  return typeof v === "string" ? v : "";
}
