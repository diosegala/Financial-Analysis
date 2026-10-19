import type { ReactNode } from "react";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { MONTHS_FULL } from "@/lib/format";

const NONE = "__none";

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string | undefined;
  children: ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      {children}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

export interface Option {
  value: string;
  label: string;
}

/** Select with an optional "none" entry (Radix Select does not accept empty values). */
export function OptionSelect({
  value,
  onChange,
  options,
  noneLabel,
  placeholder = "Selecione",
  className,
  disabled,
}: {
  value: string | null | undefined;
  onChange: (v: string | null) => void;
  options: Option[];
  noneLabel?: string | undefined;
  placeholder?: string | undefined;
  className?: string | undefined;
  disabled?: boolean | undefined;
}) {
  return (
    <Select
      value={value ?? (noneLabel ? NONE : "")}
      onValueChange={(v) => onChange(v === NONE ? null : v)}
      disabled={disabled ?? false}
    >
      <SelectTrigger className={className}>
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        {noneLabel && <SelectItem value={NONE}>{noneLabel}</SelectItem>}
        {options.map((o) => (
          <SelectItem key={o.value} value={o.value}>
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

export function MonthSelect({
  value,
  onChange,
  className,
  noneLabel,
}: {
  value: number | null;
  onChange: (m: number | null) => void;
  className?: string | undefined;
  noneLabel?: string | undefined;
}) {
  return (
    <OptionSelect
      className={className}
      value={value === null ? null : String(value)}
      onChange={(v) => onChange(v === null ? null : Number(v))}
      noneLabel={noneLabel}
      options={MONTHS_FULL.map((m, i) => ({ value: String(i + 1), label: m }))}
    />
  );
}
