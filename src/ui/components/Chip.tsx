import type { ReactNode } from "react";
import { Icon, type IconName } from "@/ui/icons";

/**
 * Status pill. Tones carry meaning, never decoration: success (open, paid,
 * met), warning (pending, limits near), danger (overdue, safety, locked),
 * attention (spots left, your turn), info (flexible, neutral facts in the
 * accent), coordinator (the coordinator's turn), neutral (ids, plain labels).
 */
export type ChipTone = "neutral" | "success" | "warning" | "danger" | "attention" | "info" | "coordinator";

const TONES: Record<ChipTone, string> = {
  neutral: "bg-sunken text-muted",
  success: "bg-success-soft text-success-ink",
  warning: "bg-warning-soft text-warning-ink",
  danger: "bg-danger-soft text-danger-ink",
  attention: "bg-attention-soft text-attention-ink",
  info: "bg-accent-soft text-link",
  coordinator: "bg-coordinator-soft text-coordinator-ink",
};

/** `icon`: a leading 14 px line icon for a chip whose meaning has one (the lock on Confidential). */
export function Chip({ tone = "neutral", icon, children }: Readonly<{ tone?: ChipTone; icon?: IconName; children: ReactNode }>) {
  return (
    <span
      className={`inline-flex w-fit items-center gap-1 rounded-full px-2.25 py-0.75 text-xs font-semibold whitespace-nowrap ${TONES[tone]}`}
    >
      {icon ? <Icon name={icon} size={14} /> : null}
      {children}
    </span>
  );
}
