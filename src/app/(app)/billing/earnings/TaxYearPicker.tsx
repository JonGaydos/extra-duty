"use client";

import { useRouter } from "next/navigation";
import { Select } from "@/ui/components/FormField";

/** Chooses the tax summary's year. */
export function TaxYearPicker({ years, year, path }: Readonly<{ years: number[]; year: number; path: string }>) {
  const router = useRouter();
  return (
    <Select aria-label="Tax year" value={String(year)} onChange={(e) => router.replace(`${path}?year=${e.target.value}`, { scroll: false })} className="w-auto">
      {years.map((y) => (
        <option key={y} value={y}>
          {y}
        </option>
      ))}
    </Select>
  );
}
