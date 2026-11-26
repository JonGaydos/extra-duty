import { cloneElement, useId, type InputHTMLAttributes, type Ref, type ReactElement, type SelectHTMLAttributes, type TextareaHTMLAttributes } from "react";
import { withClass } from "./with-class";

const CONTROL =
  "w-full border border-field bg-surface text-ink placeholder:text-muted " +
  "focus-visible:border-focus focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-focus " +
  "aria-invalid:border-danger disabled:cursor-not-allowed disabled:bg-subtle disabled:text-muted";

const INPUT_SIZES = {
  md: "h-11 rounded-sm px-3 text-body",
  lg: "h-12 rounded-md px-3.5 text-title",
  code: "h-14 rounded-md px-3.5 text-center text-xl font-semibold tracking-[0.3em]",
};

/** md: 44 px, the default. lg: 48 px, 15 px text, for short standalone forms such as sign-in. code: a one-time code. */
export function Input({
  className,
  size = "md",
  ...rest
}: Omit<InputHTMLAttributes<HTMLInputElement>, "size"> & { size?: keyof typeof INPUT_SIZES; ref?: Ref<HTMLInputElement> }) {
  const height = INPUT_SIZES[size];
  return <input className={withClass(`${CONTROL} ${height}`, className)} {...rest} />;
}

export function Select({ className, ...rest }: Readonly<SelectHTMLAttributes<HTMLSelectElement>>) {
  return <select className={withClass(`${CONTROL} h-11 rounded-sm px-3 text-body`, className)} {...rest} />;
}

export function TextArea({ className, ...rest }: Readonly<TextareaHTMLAttributes<HTMLTextAreaElement>>) {
  return <textarea className={withClass(`${CONTROL} min-h-21 resize-y rounded-sm px-3 py-2.5 text-body`, className)} {...rest} />;
}

type ControlProps = { id?: string; "aria-describedby"?: string; "aria-invalid"?: boolean };

/**
 * Label above, control, then hint or error below. Wires the label, the hint
 * and the error to the control (id, aria-describedby, aria-invalid).
 */
export function FormField({
  label,
  hint,
  error,
  children,
}: Readonly<{
  label: string;
  hint?: string;
  error?: string;
  children: ReactElement<ControlProps>;
}>) {
  const auto = useId();
  const id = children.props.id ?? auto;
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [children.props["aria-describedby"], hintId, errorId].filter(Boolean).join(" ") || undefined;
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-sm font-medium text-muted">
        {label}
      </label>
      {cloneElement(children, { id, "aria-describedby": describedBy, "aria-invalid": error ? true : undefined })}
      {hint ? (
        <p id={hintId} className="m-0 text-xs text-muted">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={errorId} className="m-0 text-xs font-medium text-danger-ink">
          {error}
        </p>
      ) : null}
    </div>
  );
}
