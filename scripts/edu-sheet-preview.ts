/**
 * Prévia da leitura da planilha de produtos de Educação, sem gravar nada no banco.
 *
 *   python3 scripts/xlsx-to-grid.py "[EDU] Produtos _ DRE 2027.xlsx" grade.json
 *   bun scripts/edu-sheet-preview.ts --grid grade.json --out previa.html [--year 2027] [--by-position]
 *
 * --by-position lê as colunas F a Q como janeiro a dezembro quando a linha 2 não tem as datas do ano (só na prévia).
 * A planilha e a prévia têm valores do negócio: ficam fora do repositório.
 */
import { readFileSync, writeFileSync } from "node:fs";
import {
  parseTab,
  type ParsedTab,
  type SheetTab,
} from "../supabase/functions/edu-sheet-sync/parse";

const args = process.argv.slice(2);
const arg = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const grid = arg("grid");
const out = arg("out");
if (!grid || !out) {
  console.error("Use: bun scripts/edu-sheet-preview.ts --grid grade.json --out previa.html");
  process.exit(1);
}
const year = Number(arg("year") ?? 2027);
const byPosition = args.includes("--by-position");

const { tabs } = JSON.parse(readFileSync(grid, "utf-8")) as { tabs: SheetTab[] };
const parsed = tabs.map((t) => parseTab(t, year, { byPosition }));

const MONTHS = ["Jan", "Fev", "Mar", "Abr", "Mai", "Jun", "Jul", "Ago", "Set", "Out", "Nov", "Dez"];
const KIND = {
  receita: "Receita",
  taxa: "Taxas",
  imposto: "Impostos",
  custo: "Custo",
  despesa: "Despesa",
};
const brl = (n: number) => (n ? n.toLocaleString("pt-BR", { maximumFractionDigits: 0 }) : "—");
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
const sum = (a: number[]) => a.reduce((x, y) => x + y, 0);

function tabHtml(p: ParsedTab) {
  if (p.error)
    return `<section><h2>${esc(p.tab)}</h2><p class="err">Não lida: ${esc(p.error)}</p></section>`;
  const sign = (k: string) => (k === "receita" ? 1 : -1);
  const rows = p.blocks
    .map(
      (b) =>
        `<tr><td>${KIND[b.kind]}</td><td>${esc(b.label)} <small>(linha ${b.row})</small></td>${b.months
          .map((v) => `<td class="n">${brl(v)}</td>`)
          .join(
            "",
          )}<td class="n b">${brl(sum(b.months))}</td><td class="n">${brl(b.outside)}</td></tr>`,
    )
    .join("");
  const net = Array.from({ length: 12 }, (_, i) =>
    p.blocks.reduce((a, b) => a + sign(b.kind) * b.months[i]!, 0),
  );
  return `<section><h2>${esc(p.tab)} <small>${esc(p.title)}</small></h2>
  ${p.byPosition ? `<p class="warn">Linha 2 sem as datas de ${year}: lida pela posição (F = janeiro), só nesta prévia.</p>` : ""}
  ${p.warnings.map((w) => `<p class="warn">${esc(w)}</p>`).join("")}
  <table><thead><tr><th>Tipo</th><th>Bloco</th>${MONTHS.map((m) => `<th>${m}</th>`).join("")}<th>${year}</th><th>Fora de ${year}</th></tr></thead>
  <tbody>${rows}
  <tr class="b"><td></td><td>Resultado do produto (app)</td>${net.map((v) => `<td class="n">${brl(v)}</td>`).join("")}<td class="n">${brl(sum(net))}</td><td></td></tr>
  <tr><td></td><td>Contribuição Líquida (planilha)</td>${p.contribution.map((v) => `<td class="n">${brl(v)}</td>`).join("")}<td class="n">${brl(sum(p.contribution))}</td><td></td></tr>
  </tbody></table></section>`;
}

const ok = parsed.filter((p) => !p.error);
const total = (k: string[]) =>
  Array.from({ length: 12 }, (_, i) =>
    ok.reduce(
      (a, p) =>
        a + p.blocks.filter((b) => k.includes(b.kind)).reduce((x, b) => x + b.months[i]!, 0),
      0,
    ),
  );
const rec = total(["receita"]);
const ded = total(["taxa", "imposto"]);
const cus = total(["custo", "despesa"]);
const line = (name: string, v: number[]) =>
  `<tr><td>${name}</td>${v.map((x) => `<td class="n">${brl(x)}</td>`).join("")}<td class="n b">${brl(sum(v))}</td></tr>`;

writeFileSync(
  out,
  `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>Prévia da planilha de Educação</title>
<style>body{font:13px system-ui,sans-serif;margin:24px;color:#222}table{border-collapse:collapse;margin:8px 0 24px}
td,th{border-bottom:1px solid #ddd;padding:3px 6px;white-space:nowrap}th{background:#f3f3f3;text-align:left}
.n{text-align:right;font-variant-numeric:tabular-nums}.b{font-weight:600}.err{color:#b00}.warn{color:#8a5a00;margin:2px 0}
small{color:#777;font-weight:400}</style></head><body>
<h1>Prévia da planilha de Educação · ${year}</h1>
<p>Nada foi gravado no app. ${ok.length} de ${parsed.length} abas lidas.</p>
<h2>O que entraria no plano da Educação (todas as abas lidas)</h2>
<table><thead><tr><th></th>${MONTHS.map((m) => `<th>${m}</th>`).join("")}<th>${year}</th></tr></thead><tbody>
${line("Receita bruta", rec)}${line("Taxas e impostos", ded)}${line("Custos e despesas dos produtos", cus)}
${line(
  "Resultado dos produtos",
  rec.map((v, i) => v - ded[i]! - cus[i]!),
)}</tbody></table>
${parsed.map(tabHtml).join("\n")}
</body></html>`,
);
for (const p of parsed)
  console.log(
    `${p.tab}: ${p.error ? `não lida (${p.error})` : `${p.blocks.length} blocos, ${p.warnings.length} aviso(s)${p.byPosition ? ", pela posição" : ""}`}`,
  );
console.log(`Prévia: ${out}`);
