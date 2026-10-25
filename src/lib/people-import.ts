import { parseNum } from "./format";
import { norm } from "./products-import";

/** Colunas esperadas, na ordem. A primeira linha pode ser o cabeçalho; a última é opcional. */
export const PEOPLE_COLUMNS = [
  "ID",
  "Data de admissão",
  "Cargo",
  "Equipe",
  "Salário",
  "Vínculo (opcional)",
] as const;

export interface PeopleCatalog {
  units: { id: string; name: string; name_keywords: string[] | null }[];
  contractTypes: {
    id: string;
    name: string;
    active: boolean;
    sort_order: number;
    role_keywords: string[] | null;
  }[];
}

export interface ImportedPerson {
  line: number;
  external_id: string;
  /** AAAA-MM-DD */
  hire_date: string | null;
  role_title: string;
  unit_id: string;
  contract_type_id: string;
  salary: number;
}

export interface PeopleImportResult {
  rows: ImportedPerson[];
  errors: { line: number; message: string }[];
  /** Linhas sem ID e sem equipe (totais, rodapés): não são pessoas. */
  ignored: number;
}

/** Aceita número de série do Excel, dd/mm/aaaa e aaaa-mm-dd. Devolve AAAA-MM-DD ou null. */
export function parseDate(text: string): string | null {
  const t = text.trim();
  if (t === "") return null;
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(t);
  const br = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(t);
  let y: number, m: number, d: number;
  if (iso) [y, m, d] = [Number(iso[1]), Number(iso[2]), Number(iso[3])] as [number, number, number];
  else if (br)
    [d, m, y] = [Number(br[1]), Number(br[2]), Number(br[3])] as [number, number, number];
  else if (/^\d{4,6}(\.\d+)?$/.test(t)) {
    const date = new Date(Date.UTC(1899, 11, 30) + Math.floor(Number(t)) * 86_400_000);
    [y, m, d] = [date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate()];
  } else return null;
  const check = new Date(Date.UTC(y, m - 1, d));
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== m - 1 || check.getUTCDate() !== d) {
    return null;
  }
  return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

const cleanId = (s: string) => s.trim().replace(/\.0+$/, "");

/** Lê a folha colada do Excel (tabulação), sem nomes: cada pessoa é identificada pelo ID. Não grava nada. */
export function parsePeople(text: string, catalog: PeopleCatalog): PeopleImportResult {
  const lines = text
    .replace(/\r/g, "")
    .split("\n")
    .map((l, i) => ({ number: i + 1, cells: l.split("\t").map((c) => c.trim()) }))
    .filter((l) => l.cells.some((c) => c !== ""));

  // Cabeçalho: o ID de uma pessoa é um código; texto como "ID Colaborador" é título de coluna.
  if (lines[0] && /id|codigo|matricula/.test(norm(lines[0].cells[0] ?? ""))) lines.shift();

  const rows: ImportedPerson[] = [];
  const errors: PeopleImportResult["errors"] = [];
  const seen = new Set<string>();
  let ignored = 0;
  const types = catalog.contractTypes
    .filter((c) => c.active)
    .sort((a, b) => a.sort_order - b.sort_order);

  for (const { number, cells } of lines) {
    const [id = "", admission = "", role = "", team = "", salaryText = "", contractText = ""] =
      cells;
    const fail = (message: string) => errors.push({ line: number, message });
    if (id === "" && team === "") {
      ignored++;
      continue;
    }
    const external = cleanId(id);
    if (external === "") {
      fail("Falta o ID.");
      continue;
    }
    if (seen.has(external)) {
      fail(`ID ${external} aparece mais de uma vez.`);
      continue;
    }
    seen.add(external);

    const unit = catalog.units.find(
      (u) =>
        norm(u.name) === norm(team) ||
        (u.name_keywords ?? []).some((k) => k.trim() !== "" && norm(team) === norm(k)),
    );
    if (!unit) {
      fail(`ID ${external}: a equipe "${team}" não corresponde a nenhuma unidade.`);
      continue;
    }

    const salary = parseNum(salaryText);
    if (salary === null || salary < 0) {
      fail(`ID ${external}: salário inválido.`);
      continue;
    }

    let hire: string | null = null;
    if (admission !== "") {
      hire = parseDate(admission);
      if (!hire) {
        fail(`ID ${external}: data de admissão "${admission}" inválida.`);
        continue;
      }
    }

    let contract = types[0];
    if (contractText !== "") {
      contract = types.find((c) => norm(c.name) === norm(contractText));
      if (!contract) {
        fail(`ID ${external}: vínculo "${contractText}" não existe.`);
        continue;
      }
    } else {
      const byRole = types.find((c) =>
        (c.role_keywords ?? []).some((k) => k.trim() !== "" && norm(role).includes(norm(k))),
      );
      contract = byRole ?? types[0];
    }
    if (!contract) {
      fail("Não há vínculo ativo cadastrado.");
      continue;
    }

    rows.push({
      line: number,
      external_id: external,
      hire_date: hire,
      role_title: role,
      unit_id: unit.id,
      contract_type_id: contract.id,
      salary,
    });
  }
  return { rows, errors, ignored };
}

export interface ImportedName {
  line: number;
  external_id: string;
  name: string;
}

/**
 * Lê ID e nome colados de uma planilha (tabulação, ponto e vírgula ou vírgula). Só os nomes: os salários não precisam
 * vir junto. A primeira linha pode ser o cabeçalho; linhas sem ID ou sem nome são apontadas.
 */
export function parseNames(text: string): {
  rows: ImportedName[];
  errors: { line: number; message: string }[];
} {
  const lines = text
    .replace(/\r/g, "")
    .split("\n")
    .map((l, i) => ({ number: i + 1, raw: l }))
    .filter((l) => l.raw.trim() !== "");
  const first = lines[0]?.raw ?? "";
  const delimiter = first.includes("\t") ? "\t" : first.includes(";") ? ";" : ",";
  const cells = lines.map((l) => ({
    number: l.number,
    cells: l.raw.split(delimiter).map((c) => c.trim()),
  }));
  if (cells[0] && /id|codigo|matricula/.test(norm(cells[0].cells[0] ?? ""))) cells.shift();

  const rows: ImportedName[] = [];
  const errors: { line: number; message: string }[] = [];
  const seen = new Set<string>();
  for (const { number, cells: c } of cells) {
    const id = cleanId(c[0] ?? "");
    const name = (c[1] ?? "").trim();
    if (!id || !name) {
      errors.push({ line: number, message: "Falta o ID ou o nome." });
      continue;
    }
    if (seen.has(id)) {
      errors.push({ line: number, message: `ID ${id} aparece mais de uma vez.` });
      continue;
    }
    seen.add(id);
    rows.push({ line: number, external_id: id, name });
  }
  return { rows, errors };
}
