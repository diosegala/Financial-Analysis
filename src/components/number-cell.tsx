import { useEffect, useState } from "react";
import { fmtInput, parseNum } from "@/lib/format";
import { Input } from "@/components/ui/input";

/** Campo numérico que grava ao sair. Vazio = volta para o valor calculado (null). */
export function NumberCell({
  value,
  onSave,
  disabled,
  placeholder,
  percent,
  label,
  className = "w-32",
}: {
  value: number | null;
  onSave: (v: number | null) => void;
  disabled?: boolean;
  placeholder?: string;
  percent?: boolean;
  label?: string;
  className?: string;
}) {
  const show = (v: number | null) =>
    v === null ? "" : percent ? fmtInput(v * 100, 2) : fmtInput(v, 0);
  const [text, setText] = useState(show(value));
  useEffect(() => setText(show(value)), [value]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <Input
      aria-label={label}
      className={`h-8 text-right ${className}`}
      value={text}
      disabled={disabled}
      placeholder={placeholder}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => {
        if (text.trim() === "") return value !== null && onSave(null);
        const n = parseNum(text);
        if (n === null) return setText(show(value));
        const v = percent ? n / 100 : n;
        if (v !== value) onSave(v);
      }}
    />
  );
}
