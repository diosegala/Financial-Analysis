/**
 * Carga da folha a partir da planilha (ID · Data de admissão · Cargo · Equipe · Salário), sem nomes. Mesmas regras do
 * botão "Importar planilha" da página Folha (src/lib/people-import.ts): equipe → unidade, vínculo pelo cargo, idempotente
 * pelo ID (quem já existe é pulado). Cadastrar a pessoa já cria a linha de remuneração com os meses.
 *
 *   bun scripts/load-people.ts --file folha.tsv [--version "Orçamento 2027"] [--target local] [--apply]
 *
 * A planilha tem salários: o .tsv fica fora do repositório e o script só imprime totais.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { parsePeople } from "../src/lib/people-import";

const args = process.argv.slice(2);
const arg = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const target = arg("target") === "local" ? "local" : "linked";
const versionName = arg("version") ?? "Orçamento 2027";

function query<T>(sql: string): T[] {
  const wrapped = `select coalesce(json_agg(t), '[]'::json) as j from (${sql}) t`;
  if (target === "local") {
    const out = execFileSync("psql", [
      "postgresql://postgres:postgres@127.0.0.1:54322/postgres",
      "-At",
      "-c",
      wrapped,
    ]);
    return JSON.parse(out.toString());
  }
  const out = execFileSync("supabase", [
    "db",
    "query",
    "--linked",
    "--output-format",
    "json",
    wrapped,
  ]).toString();
  const j = (JSON.parse(out.slice(out.indexOf("{"))).rows as { j: T[] | string }[])[0]!.j;
  return typeof j === "string" ? JSON.parse(j) : j;
}
const q = (v: string | number | null) =>
  v === null ? "NULL" : typeof v === "number" ? String(v) : `'${v.replace(/'/g, "''")}'`;

const file = arg("file");
if (!file) throw new Error("Falta --file");
const units = query<{ id: string; name: string; name_keywords: string[] | null }>(
  "select id, name, name_keywords from public.units where active",
);
const contractTypes = query<{
  id: string;
  name: string;
  active: boolean;
  sort_order: number;
  role_keywords: string[] | null;
}>("select id, name, active, sort_order, role_keywords from public.contract_types");
const version = query<{ id: string; year: number }>(
  `select id, year from public.budget_versions where name = ${q(versionName)}`,
)[0];
if (!version) throw new Error(`Versão "${versionName}" não encontrada.`);
const existing = new Set(
  query<{ external_id: string }>(
    `select external_id from public.people where version_id = ${q(version.id)} and external_id is not null`,
  ).map((p) => p.external_id),
);

const result = parsePeople(readFileSync(file, "utf8"), { units, contractTypes });
const fresh = result.rows.filter((r) => !existing.has(r.external_id));
const unitName = new Map(units.map((u) => [u.id, u.name]));
const ctName = new Map(contractTypes.map((c) => [c.id, c.name]));
const by = (f: (r: (typeof fresh)[number]) => string) =>
  fresh.reduce<Record<string, { pessoas: number; mensal: number }>>((a, r) => {
    const k = f(r);
    a[k] = {
      pessoas: (a[k]?.pessoas ?? 0) + 1,
      mensal: Math.round((a[k]?.mensal ?? 0) + r.salary),
    };
    return a;
  }, {});
console.log(
  `Pessoas na planilha: ${result.rows.length} · novas: ${fresh.length} · já cadastradas: ${result.rows.length - fresh.length} · linhas ignoradas: ${result.ignored}`,
);
console.log(
  "Por unidade:",
  by((r) => unitName.get(r.unit_id) ?? "?"),
);
console.log(
  "Por vínculo:",
  by((r) => ctName.get(r.contract_type_id) ?? "?"),
);
if (result.errors.length) console.log("Erros:", result.errors);
if (!args.includes("--apply")) {
  console.log("Simulação: nada foi gravado.");
  process.exit(0);
}

const startMonth = (hire: string | null) => {
  if (!hire) return null;
  const [y, m] = hire.split("-").map(Number) as [number, number];
  if (y > version.year) throw new Error(`Admissão depois de ${version.year}.`);
  return y === version.year ? m : null;
};
const sql = [
  "BEGIN;",
  ...fresh.map(
    (r) =>
      "INSERT INTO public.people (version_id, unit_id, name, role_title, contract_type_id, base_salary, start_month, external_id, hire_date) " +
      `VALUES (${q(version.id)}, ${q(r.unit_id)}, ${q(`ID ${r.external_id}`)}, ${q(r.role_title || null)}, ${q(r.contract_type_id)}, ` +
      `${r.salary}, ${q(startMonth(r.hire_date))}, ${q(r.external_id)}, ${q(r.hire_date)});`,
  ),
  "COMMIT;",
].join("\n");
const tmp = `${process.env.TMPDIR ?? "/tmp"}/load-people-${Date.now()}.sql`;
writeFileSync(tmp, sql, { mode: 0o600 });
try {
  if (target === "local") {
    execFileSync(
      "psql",
      [
        "postgresql://postgres:postgres@127.0.0.1:54322/postgres",
        "-v",
        "ON_ERROR_STOP=1",
        "-q",
        "-f",
        tmp,
      ],
      { stdio: "inherit" },
    );
  } else {
    execFileSync("supabase", ["db", "query", "--linked", "-f", tmp], {
      stdio: ["ignore", "ignore", "inherit"],
    });
  }
} finally {
  execFileSync("rm", ["-f", tmp]);
}
console.log(`Gravado (${target}).`);
