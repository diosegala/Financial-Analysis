import { useState } from "react";
import { fmtInput, parseNum } from "@/lib/format";

export interface GridPos {
  grid: string;
  row: number;
  col: number;
}

interface MoneyCellProps {
  value: number;
  onCommit: (value: number) => void;
  disabled?: boolean;
  /** Position in a grid: enables Enter/arrow navigation and multi-cell paste. */
  pos?: GridPos;
  /** Called with the pasted block (rows × columns of raw text) when more than one cell is pasted. */
  onPasteBlock?: (block: string[][]) => void;
}

function focusCell(grid: string, row: number, col: number) {
  const el = document.querySelector<HTMLInputElement>(
    `input[data-grid="${grid}"][data-row="${row}"][data-col="${col}"]`,
  );
  el?.focus();
  el?.select();
}

/** Spreadsheet-like numeric cell: displays plain number, commits on blur/Enter. */
export function MoneyCell({ value, onCommit, disabled, pos, onPasteBlock }: MoneyCellProps) {
  const [text, setText] = useState<string | null>(null);

  function commit() {
    if (text === null) return;
    const n = parseNum(text);
    setText(null);
    // Unparseable input reverts to the stored value instead of overwriting it with 0.
    if (n !== null && n !== value) onCommit(n);
  }

  return (
    <input
      type="text"
      inputMode="decimal"
      disabled={disabled}
      data-grid={pos?.grid}
      data-row={pos?.row}
      data-col={pos?.col}
      className="h-8 w-full rounded-none border-0 bg-transparent px-2 text-right font-mono text-sm tabular-nums text-foreground outline-none focus:bg-accent disabled:cursor-not-allowed disabled:text-muted-foreground"
      value={text ?? (value === 0 ? "" : fmtInput(value))}
      onChange={(e) => setText(e.target.value)}
      onFocus={(e) => e.target.select()}
      onBlur={commit}
      onPaste={(e) => {
        const raw = e.clipboardData.getData("text/plain");
        if (!onPasteBlock || !/[\t\n]/.test(raw.trim())) return;
        e.preventDefault();
        const block = raw
          .replace(/\r/g, "")
          .replace(/\n$/, "")
          .split("\n")
          .map((line) => line.split("\t"));
        setText(null);
        onPasteBlock(block);
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          setText(null);
          return;
        }
        if (!pos) {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          return;
        }
        const move: Record<string, [number, number]> = {
          Enter: [1, 0],
          ArrowDown: [1, 0],
          ArrowUp: [-1, 0],
        };
        const input = e.target as HTMLInputElement;
        if (e.key === "ArrowRight" && input.selectionStart === input.value.length)
          move["ArrowRight"] = [0, 1];
        if (e.key === "ArrowLeft" && input.selectionEnd === 0) move["ArrowLeft"] = [0, -1];
        const d = move[e.key];
        if (!d) return;
        e.preventDefault();
        commit();
        focusCell(pos.grid, pos.row + d[0], pos.col + d[1]);
      }}
    />
  );
}
