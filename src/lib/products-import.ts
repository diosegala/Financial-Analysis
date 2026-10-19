import { parseNum } from "./format";
import type { PriceModel, ProductKind } from "./products";

/** Colunas esperadas, na ordem. A primeira linha pode ser o cabeçalho. */
export const IMPORT_COLUMNS = [
  "Nome",
  "Unidade",
  "Tipo (serviço ou evento)",
  "Tipo de receita",
  "Preço",
  "Cobrança (mês, total ou único)",
  "Prazo em meses",
  "Vagas",
  "Custo por participante",
  "Custo fixo",
] as const;

export interface ImportCatalog {
  units: { id: string; name: string }[];
  revenueTypes: { id: string; name: string }[];
}

export interface ImportedProduct {
  line: number;
  name: string;
  unit_id: string | null;
  kind: ProductKind;
  revenue_type_id: string | null;
  price: number | null;
  price_model: PriceModel;
  duration_months: number | null;
  default_seats: number | null;
  cost_per_participant: number | null;
  fixed_cost: number | null;
}

export interface ImportResult {
  rows: ImportedProduct[];
  errors: { line: number; message: string }[];
}

/** Minúsculas e sem acentos, para comparar "Agência" com "agencia". */
export const norm = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").trim().toLowerCase();

const KINDS: Record<string, ProductKind> = {
  servico: "servico",
  contrato: "servico",
  evento: "evento",
  treinamento: "evento",
};

const MODELS: Record<string, PriceModel> = {
  mes: "mensal",
  mensal: "mensal",
  "por mes": "mensal",
  total: "total",
  contrato: "total",
  unico: "unico",
  avulso: "unico",
  "pagamento unico": "unico",
};

function optionalNumber(text: string): number | null | "invalid" {
  if (text.trim() === "") return null;
  const n = parseNum(text);
  return n === null || n < 0 ? "invalid" : n;
}

/** Lê produtos colados do Excel (colunas separadas por tabulação). Não grava nada. */
export function parseProducts(text: string, catalog: ImportCatalog): ImportResult {
  const lines = text
    .replace(/\r/g, "")
    .split("\n")
    .map((l, i) => ({ number: i + 1, cells: l.split("\t").map((c) => c.trim()) }))
    .filter((l) => l.cells.some((c) => c !== ""));

  // Cabeçalho: a primeira célula é "Nome" e a coluna de preço não é número.
  if (lines[0] && norm(lines[0].cells[0] ?? "") === "nome") lines.shift();

  const rows: ImportedProduct[] = [];
  const errors: ImportResult["errors"] = [];
  const seen = new Set<string>();

  for (const { number, cells } of lines) {
    const [
      name = "",
      unit = "",
      kind = "",
      rtype = "",
      price = "",
      model = "",
      months = "",
      seats = "",
      cpp = "",
      fixed = "",
    ] = cells;
    const fail = (message: string) => errors.push({ line: number, message });
    if (name === "") {
      fail("Falta o nome.");
      continue;
    }

    let unitId: string | null = null;
    if (unit !== "" && norm(unit) !== "todas") {
      unitId = catalog.units.find((u) => norm(u.name) === norm(unit))?.id ?? null;
      if (!unitId) {
        fail(`${name}: unidade "${unit}" não existe.`);
        continue;
      }
    }

    const kindValue = kind === "" ? "servico" : KINDS[norm(kind)];
    if (!kindValue) {
      fail(`${name}: tipo "${kind}" inválido. Use serviço ou evento.`);
      continue;
    }

    let revenueTypeId: string | null = null;
    if (rtype !== "") {
      revenueTypeId = catalog.revenueTypes.find((t) => norm(t.name) === norm(rtype))?.id ?? null;
      if (!revenueTypeId) {
        fail(`${name}: tipo de receita "${rtype}" não existe.`);
        continue;
      }
    }

    const modelValue = model === "" ? "mensal" : MODELS[norm(model)];
    if (!modelValue) {
      fail(`${name}: cobrança "${model}" inválida. Use mês, total ou único.`);
      continue;
    }
    if (kindValue === "evento" && modelValue !== "mensal") {
      fail(`${name}: evento não tem forma de cobrança; deixe a coluna em branco.`);
      continue;
    }

    const numbers = {
      price: optionalNumber(price),
      months: optionalNumber(months),
      seats: optionalNumber(seats),
      cpp: optionalNumber(cpp),
      fixed: optionalNumber(fixed),
    };
    const COLUMN_NAMES = {
      price: "preço",
      months: "prazo",
      seats: "vagas",
      cpp: "custo por participante",
      fixed: "custo fixo",
    } as const;
    const bad = (Object.keys(numbers) as (keyof typeof numbers)[]).find(
      (k) => numbers[k] === "invalid",
    );
    if (bad) {
      fail(`${name}: valor inválido na coluna ${COLUMN_NAMES[bad]}.`);
      continue;
    }
    const n = numbers as Record<keyof typeof numbers, number | null>;
    if (n.months !== null && (!Number.isInteger(n.months) || n.months < 1 || n.months > 120)) {
      fail(`${name}: o prazo deve ser um número inteiro de meses (1 a 120).`);
      continue;
    }

    const key = `${unitId ?? ""}|${norm(name)}`;
    if (seen.has(key)) {
      fail(`${name}: aparece mais de uma vez para a mesma unidade.`);
      continue;
    }
    seen.add(key);

    rows.push({
      line: number,
      name,
      unit_id: unitId,
      kind: kindValue,
      revenue_type_id: revenueTypeId,
      price: n.price,
      price_model: modelValue,
      duration_months: kindValue === "servico" ? n.months : null,
      default_seats: kindValue === "evento" ? n.seats : null,
      cost_per_participant: kindValue === "evento" ? n.cpp : null,
      fixed_cost: kindValue === "evento" ? n.fixed : null,
    });
  }
  return { rows, errors };
}
