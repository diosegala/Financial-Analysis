import { describe, expect, it } from "vitest";
import { computeMonth, paramFor, type Parameter } from "./dre";

const params: Parameter[] = [
  { name: "imposto", value: 0.1, validFrom: "2027-01-01" },
  { name: "imposto", value: 0.12, validFrom: "2027-07-01" },
  { name: "comissao_comercial", value: 0.05, validFrom: "2027-01-01" },
];

const base = {
  receitaComercial: 1000, receitaParceiro: 0, despesasProdutos: 0,
  folhaBase: 0, beneficios: 0, rescisoes: 0, despesas: 0,
};

describe("parâmetros com vigência", () => {
  it("mês anterior à mudança mantém o valor antigo", () => {
    expect(paramFor(params, "imposto", 2027, 6)).toBe(0.1);
  });
  it("mês da mudança em diante usa o novo valor", () => {
    expect(paramFor(params, "imposto", 2027, 7)).toBe(0.12);
    expect(paramFor(params, "imposto", 2027, 12)).toBe(0.12);
  });
});

describe("cenários por variação %", () => {
  it("otimista +10% de receita aumenta a receita bruta", () => {
    expect(computeMonth(base, params, 2027, 1, { receitaPct: 0.1, despesaPct: 0 }).receitaBruta).toBeCloseTo(1100);
  });
  it("contribuição líquida desconta comissão e imposto", () => {
    // 1000 - 50 comissão - 100 imposto
    expect(computeMonth(base, params, 2027, 1).contribuicaoLiquida).toBeCloseTo(850);
  });
});
