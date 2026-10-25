/**
 * Carga das categorias do Omie como contas do app, a partir da planilha de categorias (abas Receitas e Despesas, com a
 * coluna "Importar" sim/não). Feita uma vez pelo Dioner; depois o Fábio só confere e ajusta em Configurações.
 *
 *   bun scripts/load-categories.ts --despesas despesas.tsv --receitas receitas.tsv --review revisao.csv           (simula)
 *   bun scripts/load-categories.ts --despesas … --receitas … --review revisao.csv --apply [--target local]        (grava)
 *
 * Os .tsv são as abas copiadas da planilha (colunas Situação · Categoria · Importar). Nada é lido nem gravado na pasta
 * do usuário. O código da categoria vem de omie_categories (gravado pela leitura do Omie), e o grupo do código decide o
 * tratamento e a linha da DRE pelas regras abaixo. Contas que já existem (mesmo nome e tipo) ficam como estão.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import {
  enrichCategory,
  parseInclude,
  parseTable,
  type AccountKind,
} from "../src/lib/accounts-import";
import { norm } from "../src/lib/products-import";

type Treatment = "lancavel" | "calculada" | "fora_dre";
interface Rule {
  kind: AccountKind;
  treatment: Treatment;
  dre: string | null;
  why: string;
}

const args = process.argv.slice(2);
const arg = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const target = arg("target") === "local" ? "local" : "linked";
const apply = args.includes("--apply");

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
  const rows = JSON.parse(out.slice(out.indexOf("{"))).rows as { j: T[] | string }[];
  const j = rows[0]!.j;
  return typeof j === "string" ? JSON.parse(j) : j;
}

const has = (name: string, words: string[]) => words.some((w) => norm(name).includes(norm(w)));

// Regras da carga pelo grupo do código do Omie (decisão de 24/10). O resultado fica editável em Configurações.
const PAYROLL_CALCULATED = [
  "13º Salário",
  "Adiantamento",
  "Bolsa Estágio",
  "Férias",
  "FGTS",
  "INSS",
  "IR sobre Rendimentos",
  "Pensão Alimentícia",
  "Prólabore",
  "Pró-labore",
  "Remuneração de Funcionários",
];
const TAXES_CALCULATED = [
  "ISS",
  "PIS",
  "COFINS",
  "IRPJ",
  "CSLL",
  "Simples Nacional",
  "ICMS",
  "IPI",
];
const OUTSIDE = [
  "Dividendo",
  "Cotas em Tesouraria",
  "Transferência",
  "Pagamento de Empréstimo",
  "Adiantamento de Cliente",
  "Venda de Imobilizado",
];

function classify(tab: "receita" | "despesa", name: string, code: string | null): Rule {
  const group = code?.slice(0, 4) ?? "";
  if (has(name, OUTSIDE) || group === "2.07" || group === "1.04")
    return {
      kind: tab,
      treatment: "fora_dre",
      dre: null,
      why: "fora da DRE (transferência, dividendo, empréstimo, investimento)",
    };
  if (tab === "receita")
    return { kind: "receita", treatment: "lancavel", dre: "receita_bruta", why: "receita" };
  if (group === "2.03") {
    if (has(name, ["Rescis"]))
      return {
        kind: "folha",
        treatment: "lancavel",
        dre: "custos_indiretos",
        why: "rescisão: outros lançamentos de folha",
      };
    if (PAYROLL_CALCULATED.some((w) => norm(name).startsWith(norm(w)) || norm(name) === norm(w)))
      return {
        kind: "folha",
        treatment: "calculada",
        dre: "custos_indiretos",
        why: "folha: vem da página Folha",
      };
    return {
      kind: "folha",
      treatment: "lancavel",
      dre: "custos_indiretos",
      why: "benefício: outros lançamentos de folha",
    };
  }
  if (group === "2.06" && TAXES_CALCULATED.some((w) => norm(name) === norm(w)))
    return {
      kind: "despesa",
      treatment: "calculada",
      dre: "impostos",
      why: "imposto sobre a receita: o app calcula",
    };
  if (group === "2.02" && norm(name).startsWith("comissao"))
    return {
      kind: "despesa",
      treatment: "calculada",
      dre: "comissionamento",
      why: "comissão: o app calcula",
    };
  if (group === "2.01")
    return {
      kind: "despesa",
      treatment: "lancavel",
      dre: "despesas_produtos",
      why: "despesa direta",
    };
  return { kind: "despesa", treatment: "lancavel", dre: "despesas", why: "despesa" };
}

const codes = new Map<string, string[]>();
for (const c of query<{ name: string; code: string }>(
  "select distinct name, code from public.omie_categories where not is_total",
)) {
  codes.set(norm(c.name), [...(codes.get(norm(c.name)) ?? []), c.code]);
}
const existing = new Map(
  query<{ id: string; name: string; kind: string }>(
    "select id, name, kind from public.accounts",
  ).map((a) => [`${a.kind}|${norm(a.name)}`, a]),
);
const groupRules = query<{ keyword: string; group_name: string }>(
  "select keyword, group_name from public.account_group_rules",
);

interface Planned extends Rule {
  name: string;
  code: string | null;
  baseName: string;
  period: string | null;
  group: string | null;
  action: "criar" | "atualizar";
  existingId: string | null;
}
const planned: Planned[] = [];
const skipped: string[] = [];
for (const [tab, file] of [
  ["despesa", arg("despesas")],
  ["receita", arg("receitas")],
] as const) {
  if (!file) throw new Error(`Falta --${tab}s`);
  const rows = parseTable(readFileSync(file, "utf8")).slice(1);
  for (const r of rows) {
    const name = (r[1] ?? "").trim();
    if (!name) continue;
    if (parseInclude(r[2] ?? "") !== true) {
      skipped.push(name);
      continue;
    }
    const candidates = codes.get(norm(name)) ?? [];
    const code =
      candidates.find((c) => c.startsWith(tab === "receita" ? "1" : "2")) ?? candidates[0] ?? null;
    const rule = classify(tab, name, code);
    const e = enrichCategory({ name }, { minYear: 0, treatmentRules: [], groupRules, units: [] });
    planned.push({
      ...rule,
      name,
      code,
      baseName: e.baseName,
      period: e.period,
      group: e.group,
      action: existing.has(`${rule.kind}|${norm(name)}`) ? "atualizar" : "criar",
      existingId: existing.get(`${rule.kind}|${norm(name)}`)?.id ?? null,
    });
  }
}

const csv = [
  "acao;tipo;tratamento;linha_dre;codigo_omie;categoria;grupo;periodo;motivo",
  ...planned.map((p) =>
    [
      p.action,
      p.kind,
      p.treatment,
      p.dre ?? "",
      p.code ?? "",
      p.name,
      p.group ?? "",
      p.period ?? "",
      p.why,
    ].join(";"),
  ),
].join("\n");
if (arg("review")) writeFileSync(arg("review")!, csv);

const count = (f: (p: Planned) => string) =>
  Object.entries(
    planned.reduce<Record<string, number>>((a, p) => ({ ...a, [f(p)]: (a[f(p)] ?? 0) + 1 }), {}),
  );
console.log(`Categorias marcadas "sim": ${planned.length} (fora: ${skipped.length}).`);
console.log("Por tipo e tratamento:", Object.fromEntries(count((p) => `${p.kind}/${p.treatment}`)));
console.log("Por linha da DRE:", Object.fromEntries(count((p) => p.dre ?? "fora da DRE")));
console.log("Ações:", Object.fromEntries(count((p) => p.action)));

if (!apply) {
  console.log("Simulação: nada foi gravado.");
  process.exit(0);
}

const q = (v: string | null) => (v === null ? "NULL" : `'${v.replace(/'/g, "''")}'`);
// As 10 contas de exemplo da primeira versão, sem lançamentos, saem das listas (as 3 dos vínculos ficam).
const EXAMPLES = [
  "Receita de serviços",
  "Receita de educação",
  "Despesas de produtos",
  "Benefícios",
  "Rescisões",
  "Aluguel e condomínio",
  "Software e ferramentas",
  "Marketing",
  "Viagens",
  "Outras despesas",
];
const sql = [
  "BEGIN;",
  ...planned
    .filter((p) => p.action === "criar")
    .map(
      (p) =>
        "INSERT INTO public.accounts (name, kind, treatment, dre_line_id, omie_category_code, base_name, period, group_name) " +
        `VALUES (${q(p.name)}, ${q(p.kind)}, ${q(p.treatment)}, ${p.dre ? `(SELECT id FROM public.dre_lines WHERE code = ${q(p.dre)})` : "NULL"}, ` +
        `${q(p.code)}, ${q(p.baseName)}, ${q(p.period)}, ${q(p.group)}) ON CONFLICT (name, kind) DO NOTHING;`,
    ),
  // Conta que já existe com o mesmo nome (ex.: "Outras despesas" do exemplo) passa a ser a categoria do Omie.
  ...planned
    .filter((p) => p.action === "atualizar")
    .map(
      (p) =>
        `UPDATE public.accounts SET name = ${q(p.name)}, treatment = ${q(p.treatment)}, ` +
        `dre_line_id = ${p.dre ? `(SELECT id FROM public.dre_lines WHERE code = ${q(p.dre)})` : "NULL"}, ` +
        `omie_category_code = ${q(p.code)}, base_name = ${q(p.baseName)}, period = ${q(p.period)}, group_name = ${q(p.group)}, active = true ` +
        `WHERE id = ${q(p.existingId)};`,
    ),
  `UPDATE public.accounts a SET active = false WHERE a.name IN (${EXAMPLES.map(q).join(", ")})
     AND a.id NOT IN (${
       planned
         .filter((p) => p.existingId)
         .map((p) => q(p.existingId))
         .join(", ") || "NULL"
     })
     AND NOT EXISTS (SELECT 1 FROM public.plan_lines l WHERE l.account_id = a.id)
     AND NOT EXISTS (SELECT 1 FROM public.contract_types c WHERE c.account_id = a.id)
     AND NOT EXISTS (SELECT 1 FROM public.products p WHERE p.revenue_account_id = a.id OR p.cost_account_id = a.id);`,
  "COMMIT;",
].join("\n");
const file = `${process.env.TMPDIR ?? "/tmp"}/load-categories-${Date.now()}.sql`;
writeFileSync(file, sql);
if (target === "local") {
  execFileSync(
    "psql",
    [
      "postgresql://postgres:postgres@127.0.0.1:54322/postgres",
      "-v",
      "ON_ERROR_STOP=1",
      "-q",
      "-f",
      file,
    ],
    { stdio: "inherit" },
  );
} else {
  execFileSync("supabase", ["db", "query", "--linked", "-f", file], {
    stdio: ["ignore", "ignore", "inherit"],
  });
}
console.log(`Gravado (${target}).`);
