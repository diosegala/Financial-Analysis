import type { Account, Unit } from "./catalog";
import { matchKeyword } from "./accounts-import";
import { MONTHS, MONTHS_FULL, parseNum } from "./format";
import { norm } from "./products-import";

export const REVENUE_ORIGINS = [
  { value: "carteira", label: "Carteira atual" },
  { value: "renovacao", label: "Renovação" },
  { value: "nova", label: "Venda nova" },
];

/** Conta padrão de uma receita nova: a que tem o nome da unidade (ex.: "Receitas Fixas - Agência"), senão a primeira. */
export function unitRevenueAccount(options: Account[], unit: Unit | null | undefined) {
  return (
    options.find((a) =>
      [unit?.name, ...(unit?.name_keywords ?? [])].some((k) => !!k && matchKeyword(a.name, k)),
    ) ?? options[0]
  );
}

/** Uma linha de receita colada da planilha, pronta para lançar (ou com os erros que impedem). */
export interface PastedRevenue {
  /** Número da linha no texto colado (1 = primeira), para apontar o erro. */
  row: number;
  description: string;
  productId: string | null;
  origin: string | null;
  values: { month: number; amount: number }[];
  errors: string[];
}

const ORIGINS: Record<string, string> = {
  carteira: "carteira",
  "carteira atual": "carteira",
  renovacao: "renovacao",
  renovacoes: "renovacao",
  nova: "nova",
  novas: "nova",
  "venda nova": "nova",
  "vendas novas": "nova",
  "nova venda": "nova",
  "novas vendas": "nova",
};

const MONTH_KEYS = MONTHS.map((m) => norm(m));
const MONTH_NAMES = MONTHS_FULL.map((m) => norm(m));
/** "Jan", "janeiro", "jan/27", "01/2027" → 1..12; null quando não é mês. */
function monthOf(cell: string): number | null {
  const c = norm(cell);
  const i = MONTH_KEYS.findIndex(
    (m, k) => c === m || c === MONTH_NAMES[k] || c.startsWith(m + "/") || c.startsWith(m + "-"),
  );
  if (i >= 0) return i + 1;
  const num = c.match(/^(\d{1,2})[/-]\d{2,4}$/);
  if (num && Number(num[1]) >= 1 && Number(num[1]) <= 12) return Number(num[1]);
  return null;
}

const isNumber = (cell: string) => cell.trim() !== "" && parseNum(cell) !== null;

/**
 * Lê receitas coladas do Excel ou do Google Sheets: uma linha por lançamento, com a descrição, o produto e a origem
 * (opcionais, em qualquer ordem) e os valores de janeiro a dezembro.
 * - Com cabeçalho (Jan, Fev… ou Janeiro…), os meses vêm das colunas com esses nomes; "Produto" e "Origem" pelo nome.
 * - Sem cabeçalho, a primeira coluna é a descrição e os números que vêm depois são os meses, a partir de janeiro
 *   (ou os 12 últimos, quando a linha tem mais colunas).
 * Textos que não são descrição: o app tenta reconhecer como origem e depois como produto da unidade.
 */
export function parseRevenuePaste(
  text: string,
  products: { id: string; name: string }[],
  defaultOrigin: string | null,
): PastedRevenue[] {
  const lines = text
    .replace(/\r/g, "")
    .split("\n")
    .map((l, i) => ({
      row: i + 1,
      cells: l.split(l.includes("\t") ? "\t" : ";").map((c) => c.trim()),
    }))
    .filter((l) => l.cells.some((c) => c !== ""));
  if (lines.length === 0) return [];

  const productOf = (s: string) => products.find((p) => norm(p.name) === norm(s))?.id ?? null;

  // Cabeçalho: primeira linha com nome de mês (Jan, Fevereiro…) e nenhum valor numérico.
  const head = lines[0]!.cells;
  const headMonths = head.map(monthOf);
  const hasHeader = headMonths.some((m) => m !== null) && !head.some(isNumber);
  const col = (re: RegExp) => (hasHeader ? head.findIndex((c) => re.test(norm(c))) : -1);
  const productCol = col(/^produto/);
  const originCol = col(/^origem/);
  const descCol = hasHeader
    ? Math.max(
        0,
        head.findIndex(
          (c, i) => headMonths[i] === null && i !== productCol && i !== originCol && c !== "",
        ),
      )
    : 0;

  return (hasHeader ? lines.slice(1) : lines).map(({ row, cells }) => {
    const errors: string[] = [];
    let productId: string | null = null;
    let origin: string | null = null;
    const description = cells[descCol] ?? "";
    let monthCells: { month: number; text: string }[];
    const others: string[] = [];

    if (hasHeader) {
      monthCells = headMonths
        .map((m, i) => (m === null ? null : { month: m, text: cells[i] ?? "" }))
        .filter((m): m is { month: number; text: string } => m !== null);
      if (productCol >= 0 && cells[productCol]) {
        productId = productOf(cells[productCol]!);
        if (!productId) errors.push(`Produto "${cells[productCol]}" não cadastrado nesta unidade.`);
      }
      if (originCol >= 0 && cells[originCol]) {
        origin = ORIGINS[norm(cells[originCol]!)] ?? null;
        if (!origin)
          errors.push(
            `Origem "${cells[originCol]}" não reconhecida (use Carteira, Renovação ou Nova).`,
          );
      }
    } else {
      const rest = cells.slice(1);
      // Meses: os números do fim da linha (no máximo 12); o que vem antes deles são textos (origem, produto).
      let first = rest.length;
      while (
        first > 0 &&
        rest.length - first < 12 &&
        (isNumber(rest[first - 1]!) || rest[first - 1] === "")
      )
        first--;
      const nums = rest.slice(first);
      while (nums.length > 0 && nums.at(-1) === "") nums.pop();
      monthCells = nums.map((t, i) => ({ month: i + 1, text: t }));
      others.push(...rest.slice(0, first).filter((c) => c !== ""));
    }

    for (const t of others) {
      const o = ORIGINS[norm(t)];
      const p = productOf(t);
      if (o && !origin) origin = o;
      else if (p && !productId) productId = p;
      else errors.push(`Não reconheci "${t}" (nem origem nem produto da unidade).`);
    }

    const values: { month: number; amount: number }[] = [];
    for (const { month, text: t } of monthCells) {
      if (t === "") continue;
      const v = parseNum(t);
      if (v === null) errors.push(`Valor de ${MONTHS[month - 1]} inválido: "${t}".`);
      else if (v !== 0) values.push({ month, amount: Math.round(v * 100) / 100 });
    }

    if (description === "" && !productId) errors.push("Falta a descrição.");
    if (values.length === 0 && errors.length === 0) errors.push("Nenhum valor de mês.");
    origin = origin ?? defaultOrigin;
    if (!origin && !errors.some((e) => e.startsWith("Origem")))
      errors.push("Falta a origem (Carteira, Renovação ou Nova).");
    return { row, description, productId, origin, values, errors };
  });
}
