import { Notice, type NoticeTone } from "@/ui/components/Notice";

export type Message = { text: string; tone: NoticeTone } | null;

/** A polite live region that is always present, so screen readers hear each new message. */
export function FormMessage({ message }: Readonly<{ message: Message }>) {
  return (
    <output className="block" aria-live="polite">
      {message ? <Notice tone={message.tone}>{message.text}</Notice> : null}
    </output>
  );
}
