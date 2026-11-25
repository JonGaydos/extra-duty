"use client";

import { useLayoutEffect, useRef, type InputHTMLAttributes } from "react";
import { formatPhoneInput } from "@/lib/phone";
import { Input } from "./FormField";

/**
 * A US phone number field that shows ###-###-#### as the person types or pastes. The caret stays after the
 * digit it was after when dashes come and go; backspace over a dash removes the digit before it.
 */
export function PhoneField({
  value,
  onValue,
  ...rest
}: { value: string; onValue: (v: string) => void } & Omit<InputHTMLAttributes<HTMLInputElement>, "value" | "onChange" | "type" | "inputMode" | "size">) {
  const ref = useRef<HTMLInputElement>(null);
  const caret = useRef<number | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (el && caret.current !== null && document.activeElement === el) el.setSelectionRange(caret.current, caret.current);
    caret.current = null;
  }, [value]);
  return (
    <Input
      ref={ref}
      type="tel"
      inputMode="numeric"
      autoComplete="tel"
      placeholder="555-555-5555"
      maxLength={20}
      {...rest}
      value={value}
      onChange={(e) => {
        const next = formatPhoneInput(value, e.target.value, e.target.selectionStart ?? e.target.value.length);
        caret.current = next.cursor;
        onValue(next.value);
      }}
      data-numeric
    />
  );
}
