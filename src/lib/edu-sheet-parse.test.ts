import { describe, expect, it } from "vitest";
import {
  headerMonth,
  parseTab,
  referencedRows,
  type Cell,
} from "../../supabase/functions/edu-sheet-sync/parse";

/** Aba mínima: linha 2 com os meses de 2027 e 2028, ROB com dois blocos, custo com um bloco que se repete. */
function sheet(header: Cell[]) {
  const values: Cell[][] = [];
  const formulas: Cell[][] = [];
  const put = (r: number, label: string, d: Cell, months: number[] = []) => {
    values[r - 1] = [label, null, null, null, null, ...months];
    formulas[r - 1] = [label, null, null, d];
  };
  values[0] = ["PRODUTO TESTE - 10/03"];
  formulas[0] = values[0];
  values[1] = ["DRE", "QUANTIDADE", null, "VALOR", "OBS.", ...header, "TOTAL"];
  formulas[1] = values[1];
  const jan = (v: number) => [v, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 5];
  put(3, "Receita Operacional Bruta (ROB) (+)", "=D4+D6", jan(1100));
  put(4, "INGRESSOS", "=SUM(D5:D5)", jan(1000));
  put(6, "PATROCINIO", "=SUM(D7:D7)", jan(100));
  put(8, "Taxas sobre ROB (-)", "=D9", jan(30));
  put(10, "Impostos sobre ROB (-)", "=D11", jan(70));
  put(12, "Custo dos Serviços Prestadors (-)", "=D13+D15+D14", jan(500));
  put(13, "CUSTO PARCEIRO sobre ROB (-)", "=SUM(D16:D17)", jan(300));
  put(14, "COMERCIAL: Comissão", "=C14*D3", jan(50));
  put(15, "COMISSÃO", "=D14+D18", jan(150));
  put(20, "Depesas (-)", "=SUM(D21,D22)", jan(0));
  put(24, "Contribuição Líquida (=)", "=D3-D8-D10-D12-D20", jan(500));
  return { title: "Teste Plan", values, formulas };
}
const months = (y: number) =>
  Array.from({ length: 12 }, (_, i) => `${y}-${String(i + 1).padStart(2, "0")}-01`);

describe("leitura da aba de produto", () => {
  it("acha as linhas citadas na fórmula", () => {
    expect(referencedRows("=D4+D133+D194")).toEqual([4, 133, 194]);
    expect(referencedRows("=SUM(D344,D345,$D$346)")).toEqual([344, 345, 346]);
    expect(referencedRows("=SUM(D5:D7)")).toEqual([5, 6, 7]);
    expect(referencedRows("1000")).toEqual([]);
  });

  it("lê a data do cabeçalho em série do Sheets ou ISO", () => {
    expect(headerMonth(46388)).toEqual({ year: 2027, month: 1 });
    expect(headerMonth("2027-03-01")).toEqual({ year: 2027, month: 3 });
    expect(headerMonth("DRE")).toBeNull();
  });

  it("separa os blocos pelo ano do plano e confere com a contribuição", () => {
    const p = parseTab(sheet([...months(2027), months(2028)[0]!]), 2027);
    expect(p.error).toBeUndefined();
    expect(p.blocks.map((b) => [b.kind, b.label])).toEqual([
      ["receita", "INGRESSOS"],
      ["receita", "PATROCINIO"],
      ["taxa", "Taxas sobre ROB (-)"],
      ["imposto", "Impostos sobre ROB (-)"],
      ["custo", "CUSTO PARCEIRO sobre ROB (-)"],
      ["custo", "COMERCIAL: Comissão"],
      ["custo", "COMISSÃO"],
    ]);
    expect(p.blocks[0]!.months[0]).toBe(1000);
    expect(p.blocks[0]!.outside).toBe(5);
    expect(p.warnings.some((w) => w.includes("duas vezes"))).toBe(true);
  });

  it("recusa a aba sem os 12 meses do ano, a não ser pela posição", () => {
    expect(parseTab(sheet(months(2026)), 2027).error).toMatch(/12 meses de 2027/);
    const p = parseTab(sheet(months(2026)), 2027, { byPosition: true });
    expect(p.byPosition).toBe(true);
    expect(p.blocks[0]!.months[0]).toBe(1000);
  });
});
