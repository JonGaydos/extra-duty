import { FormField, Input } from "@/ui/components/FormField";
import { Notice } from "@/ui/components/Notice";

/** New password and its confirmation, as set by an invite or a reset. */
export function PasswordFields({ minLength, label = "Password" }: { minLength: number; label?: string }) {
  return (
    <>
      <FormField label={label} hint={`At least ${minLength} characters.`}>
        <Input id="password" name="password" type="password" autoComplete="new-password" minLength={minLength} size="lg" required />
      </FormField>
      <FormField label={`Confirm ${label.toLowerCase()}`}>
        <Input id="confirm" name="confirm" type="password" autoComplete="new-password" minLength={minLength} size="lg" required />
      </FormField>
    </>
  );
}

/** Shown once a password is set. */
export function PasswordSet() {
  return (
    <div role="status">
      <Notice tone="success" as="div">
        Your password is set. <a href="/sign-in">Sign in</a> with it and the 6-digit code we email you.
      </Notice>
    </div>
  );
}
