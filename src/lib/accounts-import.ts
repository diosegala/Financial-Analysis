import { norm } from "./products-import";

export type AccountKind = "receita" | "despesa" | "folha";

export const KIND_LABELS: Record<AccountKind, string> = {
  receita: "Receitas",
  despesa: "Despesas",
  folha: "Folha",
};

/** Lê uma tabela colada do Excel (tabulação) ou de um CSV (; ou ,). Não interpreta colunas. */
export function parseTable(text: string): string[][] {
  const lines = text
    .replace(/\r/g, "")
    .split("\n")
    .filter((l) => l.trim() !== "");
  if (lines.length === 0) return [];
  const first = lines[0]!;
  const delimiter = first.includes("\t") ? "\t" : first.includes(";") ? ";" : ",";
  return lines.map((l) =>
    l.split(delimiter).map((c) =>
      c
        .trim()
        .replace(/^"(.*)"$/, "$1")
        .trim(),
    ),
  );
}

/** Código de conta no estilo 1, 1.01, 2.03.05. */
export const looksLikeCode = (c: string) => /^\d+([.-]\d+)*$/.test(c.trim());

/** A primeira linha é cabeçalho quando nenhuma célula dela parece um código de conta. */
export function guessHasHeader(rows: string[][]): boolean {
  return rows.length > 1 && !rows[0]!.some(looksLikeCode);
}

export interface ColumnGuess {
  code: number | null;
  name: number | null;
  type: number | null;
}

/** Sugere quais colunas são código, nome e tipo, pelo cabeçalho e, na falta dele, pelos dados. */
export function guessColumns(rows: string[][], hasHeader: boolean): ColumnGuess {
  const width = Math.max(0, ...rows.map((r) => r.length));
  const header = hasHeader ? (rows[0] ?? []).map((h) => norm(h)) : [];
  const data = hasHeader ? rows.slice(1) : rows;
  const col = (i: number) => data.map((r) => (r[i] ?? "").trim()).filter((c) => c !== "");

  const find = (re: RegExp, skip: (number | null)[]) => {
    const i = header.findIndex((h, idx) => !skip.includes(idx) && re.test(h));
    return i >= 0 ? i : null;
  };

  let code = find(/^(codigo|cod\b|code|numero|n[o°º])/, []);
  if (code === null) {
    // coluna em que a maioria dos valores parece um código
    const best = [...Array(width).keys()]
      .map((i) => ({ i, share: col(i).filter(looksLikeCode).length / Math.max(1, col(i).length) }))
      .sort((a, b) => b.share - a.share)[0];
    code = best && best.share >= 0.6 ? best.i : null;
  }

  let name = find(/(descricao|nome|categoria|conta)/, [code]);
  if (name === null) {
    const candidate = [...Array(width).keys()].find(
      (i) => i !== code && col(i).length > 0 && col(i).filter(looksLikeCode).length === 0,
    );
    name = candidate ?? null;
  }

  let type = find(/(tipo|natureza|grupo|classifica)/, [code, name]);
  if (type === null) {
    // coluna de texto com poucos valores diferentes (Receita, Despesa…)
    const candidate = [...Array(width).keys()].find((i) => {
      if (i === code || i === name) return false;
      const values = col(i);
      return (
        values.length > 0 &&
        new Set(values.map(norm)).size <= 6 &&
        values.filter(looksLikeCode).length === 0 &&
        // uma coluna só com "Ativo" (situação) não é o tipo: precisa ter algum valor que diga receita ou despesa
        values.some((v) => guessKind(v) !== null)
      );
    });
    type = candidate ?? null;
  }
  return { code, name, type };
}

/** Receita ou despesa pelo texto do tipo. Folha não é adivinhada: quem importa escolhe. */
export function guessKind(text: string): AccountKind | null {
  const t = norm(text);
  if (/receita|entrada|credito|recebimento|faturamento/.test(t)) return "receita";
  if (/despesa|saida|custo|debito|pagamento/.test(t)) return "despesa";
  return null;
}

export interface ImportRow {
  line: number;
  code: string;
  name: string;
  kind: AccountKind | null;
  /** Tem subcontas: no Omie é um grupo, onde não se lança. */
  isGroup: boolean;
  /** Colunas opcionais da planilha de categorias. */
  department?: string;
  groupHint?: string;
  /** Coluna "Importar? sim/não": null quando não há coluna ou a célula está vazia. */
  includeFlag?: boolean | null;
}

/** Colunas opcionais além de código, nome e tipo. */
export interface ExtraColumns {
  department?: number | null | undefined;
  group?: number | null | undefined;
  include?: number | null | undefined;
}

export function toImportRows(
  rows: string[][],
  hasHeader: boolean,
  columns: ColumnGuess,
  extra: ExtraColumns = {},
): { rows: ImportRow[]; errors: { line: number; message: string }[] } {
  const data = hasHeader ? rows.slice(1) : rows;
  const offset = hasHeader ? 2 : 1;
  const cell = (r: string[], i: number | null) => (i === null ? "" : (r[i] ?? "").trim());
  const errors: { line: number; message: string }[] = [];
  const parsed: Omit<ImportRow, "isGroup">[] = [];
  const seenCodes = new Set<string>();

  data.forEach((r, idx) => {
    const line = idx + offset;
    const code = cell(r, columns.code);
    const name = cell(r, columns.name);
    if (name === "") {
      if (code !== "") errors.push({ line, message: `${code}: falta o nome.` });
      return;
    }
    if (code !== "") {
      if (seenCodes.has(code)) {
        errors.push({ line, message: `${name}: o código ${code} aparece mais de uma vez.` });
        return;
      }
      seenCodes.add(code);
    }
    const department = cell(r, extra.department ?? null);
    const groupHint = cell(r, extra.group ?? null);
    parsed.push({
      line,
      code,
      name,
      kind: columns.type === null ? null : guessKind(cell(r, columns.type)),
      ...(department ? { department } : {}),
      ...(groupHint ? { groupHint } : {}),
      ...(extra.include != null ? { includeFlag: parseInclude(cell(r, extra.include)) } : {}),
    });
  });

  const codes = [...seenCodes];
  const rowsOut = parsed.map((p) => ({
    ...p,
    isGroup:
      p.code !== "" &&
      codes.some((c) => c !== p.code && (c.startsWith(`${p.code}.`) || c.startsWith(`${p.code}-`))),
  }));
  return { rows: rowsOut, errors };
}

export interface ExistingAccount {
  id: string;
  name: string;
  kind: string;
  dre_line_id: string | null;
  omie_category_code: string | null;
}

export type ImportAction = "criar" | "vincular" | "existente";

export interface PlannedAccount extends ImportRow {
  action: ImportAction;
  /** Nome que a conta terá (acrescenta o código quando o nome se repete). */
  finalName: string;
  /** Conta já cadastrada, quando action é vincular ou existente. */
  matchId: string | null;
}

/**
 * Decide o que fazer com cada linha, sem gravar nada:
 * - existente: já há conta com este código do Omie; fica como está.
 * - vincular: já há conta com o mesmo nome e sem código; só recebe o código do Omie.
 * - criar: conta nova. Nomes repetidos ganham o código, ex.: "Outros (2.03)".
 */
export function planAccounts(
  rows: ImportRow[],
  existing: ExistingAccount[],
  options: { skipGroups: boolean },
): { items: PlannedAccount[]; skippedGroups: number; errors: { line: number; message: string }[] } {
  const byCode = new Map(
    existing.filter((a) => a.omie_category_code).map((a) => [a.omie_category_code!, a]),
  );
  const byName = new Map(existing.map((a) => [norm(a.name), a]));
  const usedNames = new Set(existing.map((a) => norm(a.name)));
  const errors: { line: number; message: string }[] = [];

  const candidates = options.skipGroups ? rows.filter((r) => !r.isGroup) : rows;
  const skippedGroups = rows.length - candidates.length;

  // Nomes que se repetem entre as contas novas do arquivo.
  const newOnes = candidates.filter(
    (r) => !(r.code && byCode.has(r.code)) && !isLinkable(r, byName),
  );
  const nameCount = new Map<string, number>();
  for (const r of newOnes) nameCount.set(norm(r.name), (nameCount.get(norm(r.name)) ?? 0) + 1);

  const items: PlannedAccount[] = [];
  for (const r of candidates) {
    const byCodeMatch = r.code ? byCode.get(r.code) : undefined;
    if (byCodeMatch) {
      items.push({
        ...r,
        action: "existente",
        finalName: byCodeMatch.name,
        matchId: byCodeMatch.id,
      });
      continue;
    }
    const nameMatch = byName.get(norm(r.name));
    if (nameMatch && !nameMatch.omie_category_code) {
      items.push({ ...r, action: "vincular", finalName: nameMatch.name, matchId: nameMatch.id });
      continue;
    }
    const clashes = usedNames.has(norm(r.name)) || (nameCount.get(norm(r.name)) ?? 0) > 1;
    const finalName = clashes && r.code ? `${r.name} (${r.code})` : r.name;
    if (usedNames.has(norm(finalName))) {
      errors.push({ line: r.line, message: `${r.name}: já existe uma conta com este nome.` });
      continue;
    }
    usedNames.add(norm(finalName));
    items.push({ ...r, action: "criar", finalName, matchId: null });
  }
  return { items, skippedGroups, errors };
}

function isLinkable(r: ImportRow, byName: Map<string, ExistingAccount>) {
  const m = byName.get(norm(r.name));
  return !!m && !m.omie_category_code;
}

/** Linha da DRE mais usada pelas contas atuais de um tipo: o padrão para as importadas. */
export function defaultDreLine(existing: ExistingAccount[], kind: AccountKind): string | null {
  const counts = new Map<string, number>();
  for (const a of existing.filter((x) => x.kind === kind && x.dre_line_id))
    counts.set(a.dre_line_id!, (counts.get(a.dre_line_id!) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
}

// ───────────────────────── Categorias do Omie: período, tratamento, grupo e unidade ─────────────────────────

export type Treatment = "lancavel" | "calculada" | "fora_dre";

export const TREATMENT_LABELS: Record<Treatment, string> = {
  lancavel: "Lançável",
  calculada: "Calculada pelo app",
  fora_dre: "Fora da DRE",
};

/** Coluna "Importar? sim/não": sim → true, não → false, vazio ou outra coisa → null. */
export function parseInclude(value: string): boolean | null {
  const v = norm(value);
  if (["sim", "s", "1", "true", "x", "importar", "incluir"].includes(v)) return true;
  if (["nao", "n", "0", "false", "excluir", "ignorar", "vermelho"].includes(v)) return false;
  return null;
}

/** Sugere as colunas opcionais pelos nomes do cabeçalho. Sem cabeçalho, não adivinha. */
export function guessExtraColumns(
  rows: string[][],
  hasHeader: boolean,
  taken: (number | null)[],
): ExtraColumns {
  if (!hasHeader) return {};
  const header = (rows[0] ?? []).map((h) => norm(h));
  const find = (re: RegExp) => {
    const i = header.findIndex((h, idx) => !taken.includes(idx) && re.test(h));
    return i >= 0 ? i : null;
  };
  return {
    department: find(/(departamento|depto|dept)/),
    group: find(/(grupo|familia)/),
    include: find(/(importar|incluir|usar)/),
  };
}

export interface PeriodSplit {
  baseName: string;
  /** "2027" ou "2026/2027"; null quando o nome não termina em ano. */
  period: string | null;
  startYear: number | null;
  endYear: number | null;
}

/**
 * Separa o período do nome da categoria: "CUPOLA Summit Ingressos - 2027" →
 * base "CUPOLA Summit Ingressos", período "2027". Aceita "- 2026/2027" e "- 2026/27".
 */
export function splitPeriod(name: string): PeriodSplit {
  const m = name.trim().match(/^(.*?)(?:\s*[-–—]\s*|\s+)(20\d{2})(?:\s*\/\s*(\d{4}|\d{2}))?\s*$/);
  if (!m || !m[1]!.trim())
    return { baseName: name.trim(), period: null, startYear: null, endYear: null };
  const start = Number(m[2]);
  const rawEnd = m[3];
  const end = rawEnd ? (rawEnd.length === 2 ? 2000 + Number(rawEnd) : Number(rawEnd)) : null;
  return {
    baseName: m[1]!.trim(),
    period: end ? `${start}/${end}` : `${start}`,
    startYear: start,
    endYear: end ?? start,
  };
}

/** O período termina antes do ano mínimo (ex.: 2025 com mínimo 2026). Sem período, nunca é anterior. */
export const isBeforeYear = (split: PeriodSplit, minYear: number) =>
  split.endYear !== null && split.endYear < minYear;

/** A palavra aparece no nome como palavra inteira (ou frase), com plural simples e sem diferenciar acento. */
export function matchKeyword(name: string, keyword: string): boolean {
  const kw = norm(keyword)
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\s+/g, "\\s+");
  if (!kw) return false;
  return new RegExp(`(^|[^a-z0-9])${kw}s?($|[^a-z0-9])`).test(norm(name));
}

const longestFirst = <T extends { keyword: string }>(rules: T[]) =>
  [...rules].sort((a, b) => b.keyword.length - a.keyword.length);

export function suggestTreatment(
  name: string,
  rules: { keyword: string; treatment: string }[],
): { treatment: Treatment; keyword: string } | null {
  const hit = longestFirst(rules).find((r) => matchKeyword(name, r.keyword));
  return hit ? { treatment: hit.treatment as Treatment, keyword: hit.keyword } : null;
}

export function suggestGroup(
  name: string,
  rules: { keyword: string; group_name: string }[],
): string | null {
  return longestFirst(rules).find((r) => matchKeyword(name, r.keyword))?.group_name ?? null;
}

export interface UnitInfo {
  id: string;
  name: string;
  omie_department_code: string | null;
  name_keywords: string[] | null;
}

export interface UnitMatch {
  unitId: string | null;
  source: "departamento" | "nome" | null;
  /** Mais de uma unidade combina com o nome: não escolhe nenhuma. */
  ambiguous: boolean;
  /** Veio um departamento, mas nenhuma unidade corresponde a ele. */
  unknownDepartment: boolean;
}

/**
 * A unidade vem do departamento do Omie (código ou nome da unidade). Sem departamento, usa o nome da
 * categoria, comparando com o nome da unidade e com as palavras cadastradas nela.
 */
export function resolveUnit(
  department: string | undefined,
  name: string,
  units: UnitInfo[],
): UnitMatch {
  const none = { unitId: null, source: null, ambiguous: false, unknownDepartment: false } as const;
  const dep = norm(department ?? "");
  if (dep !== "") {
    const hit = units.find(
      (u) => norm(u.omie_department_code ?? "") === dep || norm(u.name) === dep,
    );
    return hit
      ? { unitId: hit.id, source: "departamento", ambiguous: false, unknownDepartment: false }
      : { ...none, unknownDepartment: true };
  }
  const hits = units.filter((u) =>
    [u.name, ...(u.name_keywords ?? [])].some((k) => matchKeyword(name, k)),
  );
  if (hits.length === 1)
    return { unitId: hits[0]!.id, source: "nome", ambiguous: false, unknownDepartment: false };
  return { ...none, ambiguous: hits.length > 1 };
}

export interface CategoryContext {
  minYear: number;
  treatmentRules: { keyword: string; treatment: string }[];
  groupRules: { keyword: string; group_name: string }[];
  units: UnitInfo[];
}

export interface CategoryEnrichment {
  baseName: string;
  period: string | null;
  excluded: "periodo_anterior" | "marcada_nao" | null;
  treatment: Treatment;
  treatmentKeyword: string | null;
  group: string | null;
  unit: UnitMatch;
}

/** O que o app sugere para uma categoria do Omie, sem gravar nada. Tudo é revisado na tela. */
export function enrichCategory(
  row: Pick<ImportRow, "name" | "department" | "groupHint" | "includeFlag">,
  ctx: CategoryContext,
): CategoryEnrichment {
  const split = splitPeriod(row.name);
  const treatment = suggestTreatment(row.name, ctx.treatmentRules);
  return {
    baseName: split.baseName,
    period: split.period,
    excluded:
      row.includeFlag === false
        ? "marcada_nao"
        : isBeforeYear(split, ctx.minYear)
          ? "periodo_anterior"
          : null,
    treatment: treatment?.treatment ?? "lancavel",
    treatmentKeyword: treatment?.keyword ?? null,
    group: row.groupHint || suggestGroup(row.name, ctx.groupRules),
    unit: resolveUnit(row.department, row.name, ctx.units),
  };
}
