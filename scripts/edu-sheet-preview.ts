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

const line = (name: string, v: number[], cls = "") =>
  `<tr class="${cls}"><td>${name}</td>${v.map((x) => `<td class="n">${brl(x)}</td>`).join("")}<td class="n b">${brl(sum(v))}</td></tr>`;
const byMonth = (p: ParsedTab, kinds: string[]) =>
  Array.from({ length: 12 }, (_, i) =>
    p.blocks.filter((b) => kinds.includes(b.kind)).reduce((a, b) => a + b.months[i]!, 0),
  );
const head = (first: string) =>
  `<thead><tr><th>${first}</th>${MONTHS.map((m) => `<th>${m}</th>`).join("")}<th>${year}</th></tr></thead>`;

/** Um produto: receitas e despesas por mês; o detalhe por bloco fica recolhido. */
function tabHtml(p: ParsedTab) {
  const rec = byMonth(p, ["receita"]);
  const desp = byMonth(p, ["taxa", "imposto", "custo", "despesa"]);
  const detail = p.blocks
    .map((b) => line(`${KIND[b.kind]} · ${esc(b.label)} <small>(linha ${b.row})</small>`, b.months))
    .join("");
  const outside = p.blocks.reduce((a, b) => a + b.outside, 0);
  return `<section><h2>${esc(p.tab)} <small>${esc(p.title)}</small></h2>
  ${p.byPosition ? `<p class="warn">Linha 2 sem as datas de ${year}: lida pela posição (F = janeiro), só nesta prévia.</p>` : ""}
  ${p.warnings.map((w) => `<p class="warn">${esc(w)}</p>`).join("")}
  <table>${head("")}<tbody>
  ${line("Receitas", rec)}
  ${line("Despesas <small>(taxas, impostos, custos e despesas)</small>", desp)}
  ${line(
    "Resultado",
    rec.map((v, i) => v - desp[i]!),
    "b",
  )}
  </tbody></table>
  ${outside ? `<p class="note">Fora de ${year}: ${brl(outside)} (receitas e despesas do ano seguinte, não entram neste plano).</p>` : ""}
  <details><summary>Ver por bloco da planilha</summary><table>${head("Bloco")}<tbody>${detail}
  ${line("Contribuição Líquida da aba", p.contribution, "b")}</tbody></table></details></section>`;
}

const ok = parsed.filter((p) => !p.error && p.blocks.some((b) => b.months.some((v) => v !== 0)));
const skipped = parsed.filter((p) => !ok.includes(p));

writeFileSync(
  out,
  `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>Prévia da planilha de Educação</title>
<style>body{font:13px system-ui,sans-serif;margin:24px;color:#222}table{border-collapse:collapse;margin:8px 0 8px}
section{margin-bottom:28px}td,th{border-bottom:1px solid #ddd;padding:3px 6px;white-space:nowrap}th{background:#f3f3f3;text-align:left}
.n{text-align:right;font-variant-numeric:tabular-nums}.b{font-weight:600}.warn{color:#8a5a00;margin:2px 0}.note{color:#555;margin:2px 0}
small{color:#777;font-weight:400}summary{cursor:pointer;color:#555}</style></head><body>
<h1>Prévia da planilha de Educação · ${year}</h1>
<p>Por produto, receitas e despesas de cada mês. Nada foi gravado no app.</p>
${ok.map(tabHtml).join("\n")}
${skipped.length ? `<p class="note">Abas não lidas: ${skipped.map((p) => `${esc(p.tab)} (${esc(p.error ?? "sem valores")})`).join("; ")}.</p>` : ""}
</body></html>`,
);
for (const p of parsed)
  console.log(
    `${p.tab}: ${p.error ? `não lida (${p.error})` : `${p.blocks.length} blocos, ${p.warnings.length} aviso(s)${p.byPosition ? ", pela posição" : ""}`}`,
  );
console.log(`Prévia: ${out}`);
