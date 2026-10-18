import { useState } from "react";
import { parseNum } from "@/lib/format";

interface MoneyCellProps {
  value: number;
  onCommit: (value: number) => void;
  disabled?: boolean;
}

/** Spreadsheet-like numeric cell: displays plain number, commits on blur/Enter. */
export function MoneyCell({ value, onCommit, disabled }: MoneyCellProps) {
  const [text, setText] = useState<string | null>(null);

  function commit() {
    if (text === null) return;
    const n = parseNum(text);
    setText(null);
    if (n !== value) onCommit(n);
  }

  return (
    <input
      type="text"
      inputMode="decimal"
      disabled={disabled}
      className="h-8 w-full rounded-none border-0 bg-transparent px-2 text-right font-mono text-sm tabular-nums text-foreground outline-none focus:bg-accent disabled:cursor-not-allowed disabled:text-muted-foreground"
      value={text ?? (value === 0 ? "" : String(value).replace(".", ","))}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
      }}
    />
  );
}
