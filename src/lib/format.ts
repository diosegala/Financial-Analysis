export const YEAR = 2027;

export const MONTHS = [
  "Jan",
  "Fev",
  "Mar",
  "Abr",
  "Mai",
  "Jun",
  "Jul",
  "Ago",
  "Set",
  "Out",
  "Nov",
  "Dez",
];

export const MONTHS_FULL = [
  "Janeiro",
  "Fevereiro",
  "Março",
  "Abril",
  "Maio",
  "Junho",
  "Julho",
  "Agosto",
  "Setembro",
  "Outubro",
  "Novembro",
  "Dezembro",
];

const brl = new Intl.NumberFormat("pt-BR", {
  style: "currency",
  currency: "BRL",
  maximumFractionDigits: 0,
});

export function fmtBRL(v: number): string {
  return brl.format(v);
}

export function fmtPct(v: number): string {
  return `${(v * 100).toLocaleString("pt-BR", { maximumFractionDigits: 1 })}%`;
}

/**
 * Parse a numeric input typed or pasted by the user. Accepts pt-BR ("1.234,56") and
 * en ("1,234.56", "1234.56") styles. When both separators appear, the last one is the
 * decimal. A lone "." is a thousands separator only when followed by exactly 3 digits
 * and a non-zero integer part ("1.234" = 1234, "7.6" = 7.6, "0.125" = 0.125).
 * Empty input is 0; anything unparseable returns null so callers can reject it.
 */
export function parseNum(s: string): number | null {
  let clean = s.replace(/R\$|%|\s/g, "");
  if (clean === "") return 0;

  const negative = /^\(.*\)$/.test(clean) || clean.startsWith("-");
  clean = clean.replace(/^[(-]+|\)$/g, "");

  const lastComma = clean.lastIndexOf(",");
  const lastDot = clean.lastIndexOf(".");
  if (lastComma >= 0 && lastDot >= 0) {
    const decimal = lastComma > lastDot ? "," : ".";
    const thousands = decimal === "," ? "." : ",";
    clean = clean.split(thousands).join("").replace(decimal, ".");
  } else if (lastComma >= 0) {
    clean = clean.match(/,/g)!.length > 1 ? clean.split(",").join("") : clean.replace(",", ".");
  } else if (lastDot >= 0) {
    const parts = clean.split(".");
    const isThousands =
      parts.length > 2 || (parts[1]!.length === 3 && parts[0] !== "" && Number(parts[0]) !== 0);
    if (isThousands) clean = parts.join("");
  }

  if (!/^\d*\.?\d+$|^\d+\.$/.test(clean)) return null;
  const n = Number(clean);
  if (!Number.isFinite(n)) return null;
  return negative ? -n : n;
}

/** Display a stored number in an editable input, pt-BR style, without float noise. */
export function fmtInput(v: number, maxDecimals = 2): string {
  return v.toLocaleString("pt-BR", { maximumFractionDigits: maxDecimals });
}
