// Leitura de uma aba da planilha de produtos de Educação (DRE por produto). Não depende de onde a aba veio: recebe a
// grade de valores e a de fórmulas, como a Google Sheets API devolve, ou como scripts/xlsx-to-grid.py gera do .xlsx.
//
// As posições das linhas mudam de uma aba para outra; o que é estável são as fórmulas da coluna D (VALOR):
//   Receita Operacional Bruta = soma dos blocos de receita (ingressos, patrocínio, variável…)
//   Custo dos Serviços Prestados = soma dos blocos de custo
//   Despesas = soma das linhas de despesa
// Os meses vêm da linha 2 (data de cada coluna).

export type Cell = string | number | boolean | null | undefined;

export interface SheetTab {
  title: string;
  values: Cell[][];
  formulas: Cell[][];
}

export type BlockKind = "receita" | "taxa" | "imposto" | "custo" | "despesa";

export interface Block {
  kind: BlockKind;
  label: string;
  /** Linha na planilha (começa em 1). */
  row: number;
  /** Jan a dez do ano do plano. */
  months: number[];
  /** Valor nas colunas de meses fora do ano do plano. */
  outside: number;
}

export interface ParsedTab {
  tab: string;
  title: string;
  blocks: Block[];
  /** Contribuição Líquida da aba, por mês do ano do plano. */
  contribution: number[];
  /** O ano dos meses foi deduzido pela posição (só na prévia). */
  byPosition: boolean;
  warnings: string[];
  error?: string;
}

const COL_VALUE = 3; // D
const FIRST_MONTH_COL = 5; // F
const HEADER_ROW = 1; // linha 2

const norm = (v: Cell) =>
  String(v ?? "")
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .trim()
    .toLowerCase();

const num = (v: Cell) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const round2 = (n: number) => Math.round(n * 100) / 100;

/** Data do cabeçalho: número de série do Sheets/Excel ou texto ISO. Devolve ano e mês. */
export function headerMonth(v: Cell): { year: number; month: number } | null {
  if (typeof v === "number" && v > 20000 && v < 80000) {
    const d = new Date(Date.UTC(1899, 11, 30) + Math.round(v) * 86400000);
    return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1 };
  }
  const m = /^(\d{4})-(\d{2})/.exec(String(v ?? ""));
  return m ? { year: Number(m[1]), month: Number(m[2]) } : null;
}

/** Linhas citadas na fórmula da coluna D (D4, $D$4, D5:D9). */
export function referencedRows(formula: Cell): number[] {
  const f = String(formula ?? "");
  if (!f.startsWith("=")) return [];
  const rows = new Set<number>();
  for (const m of f.matchAll(/\$?D\$?(\d+)\s*:\s*\$?D\$?(\d+)/gi))
    for (let r = Number(m[1]); r <= Number(m[2]); r++) rows.add(r);
  const singles = f.replace(/\$?D\$?\d+\s*:\s*\$?D\$?\d+/gi, "");
  for (const m of singles.matchAll(/\$?D\$?(\d+)/gi)) rows.add(Number(m[1]));
  return [...rows].sort((a, b) => a - b);
}

export function parseTab(
  sheet: SheetTab,
  planYear: number,
  opts: { byPosition?: boolean } = {},
): ParsedTab {
  const { values, formulas } = sheet;
  const label = (r: number) => String(values[r]?.[0] ?? "").trim();
  const result: ParsedTab = {
    tab: sheet.title.trim(),
    title: String(values[0]?.[0] ?? "").trim(),
    blocks: [],
    contribution: Array(12).fill(0),
    byPosition: false,
    warnings: [],
  };
  const fail = (msg: string) => ({ ...result, error: msg });

  // Meses: as colunas de F até TOTAL.
  const header = values[HEADER_ROW] ?? [];
  let totalCol = header.findIndex((v, i) => i >= FIRST_MONTH_COL && norm(v) === "total");
  if (totalCol < 0) totalCol = header.length;
  const monthCols: { col: number; year: number; month: number }[] = [];
  for (let c = FIRST_MONTH_COL; c < totalCol; c++) {
    const h = headerMonth(header[c]);
    if (h) monthCols.push({ col: c, ...h });
  }
  if (monthCols.length === 0) return fail("A linha 2 não tem as datas dos meses.");
  const inYear = monthCols.filter((m) => m.year === planYear);
  const seen = new Set(inYear.map((m) => m.month));
  let colOf = new Map(inYear.map((m) => [m.month, m.col]));
  if (inYear.length !== 12 || seen.size !== 12) {
    if (!opts.byPosition)
      return fail(`As datas da linha 2 não trazem os 12 meses de ${planYear} (uma vez cada).`);
    result.byPosition = true;
    colOf = new Map(Array.from({ length: 12 }, (_, i) => [i + 1, FIRST_MONTH_COL + i]));
  }
  const yearCols = new Set(colOf.values());
  const allCols = monthCols.map((m) => m.col);
  const monthsOf = (r: number) =>
    Array.from({ length: 12 }, (_, i) => round2(num(values[r]?.[colOf.get(i + 1)!])));
  const outsideOf = (r: number) =>
    round2(allCols.filter((c) => !yearCols.has(c)).reduce((a, c) => a + num(values[r]?.[c]), 0));

  // Linhas-chave pelo rótulo.
  const find = (prefix: string) => {
    const p = norm(prefix);
    for (let r = 2; r < values.length; r++) if (norm(label(r)).startsWith(p)) return r;
    return -1;
  };
  const rob = find("Receita Operacional Bruta");
  const taxas = find("Taxas sobre ROB");
  const impostos = find("Impostos sobre ROB");
  const csp = find("Custo dos Servi");
  const despesas = find("Depesas") >= 0 ? find("Depesas") : find("Despesas (");
  const contrib = find("Contribuição Líquida (=)");
  const missing = [
    ["Receita Operacional Bruta", rob],
    ["Taxas sobre ROB", taxas],
    ["Impostos sobre ROB", impostos],
    ["Custo dos Serviços Prestados", csp],
    ["Contribuição Líquida", contrib],
  ].filter(([, r]) => (r as number) < 0);
  if (missing.length) return fail(`Não encontrei: ${missing.map(([n]) => n).join(", ")}.`);

  const add = (kind: BlockKind, r: number) =>
    result.blocks.push({
      kind,
      label: label(r),
      row: r + 1,
      months: monthsOf(r),
      outside: outsideOf(r),
    });

  const blocksOf = (r: number, kind: BlockKind) => {
    const refs = referencedRows(formulas[r]?.[COL_VALUE]).map((x) => x - 1);
    // Linhas citadas sem rótulo são espaço reservado da planilha.
    const rows = refs.filter((x) => label(x) !== "");
    if (refs.length === 0) {
      result.warnings.push(`"${label(r)}" não é uma soma de blocos: entra como um bloco só.`);
      add(kind, r);
      return;
    }
    // Bloco citado que também está dentro de outro bloco citado: a planilha soma duas vezes.
    for (const x of rows)
      for (const y of rows)
        if (x !== y && referencedRows(formulas[y]?.[COL_VALUE]).includes(x + 1))
          result.warnings.push(
            `"${label(r)}" soma "${label(x)}" duas vezes (direto e dentro de "${label(y)}").`,
          );
    for (const x of rows) add(kind, x);
  };

  blocksOf(rob, "receita");
  add("taxa", taxas);
  add("imposto", impostos);
  blocksOf(csp, "custo");
  if (despesas >= 0) blocksOf(despesas, "despesa");
  result.contribution = monthsOf(contrib);

  // Conferências com a própria aba.
  const sum = (k: BlockKind[]) =>
    result.blocks
      .filter((b) => k.includes(b.kind))
      .reduce((a, b) => a + b.months.reduce((x, y) => x + y, 0), 0);
  const computed = sum(["receita"]) - sum(["taxa", "imposto", "custo", "despesa"]);
  const sheetContribution = result.contribution.reduce((a, b) => a + b, 0);
  if (Math.abs(computed - sheetContribution) > 1)
    result.warnings.push(
      `Receita menos custos dá ${round2(computed)} no ano; a Contribuição Líquida da aba dá ${round2(sheetContribution)}.`,
    );
  const outside = result.blocks.reduce((a, b) => a + Math.abs(b.outside), 0);
  if (outside > 0.5)
    result.warnings.push(
      `Há valores em meses fora de ${planYear}; eles não entram no plano deste ano.`,
    );
  return result;
}
