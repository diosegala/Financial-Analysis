import { describe, expect, it } from "vitest";
import { parseRevenuePaste } from "./revenue-paste";

const products = [
  { id: "p1", name: "Imersão Vendas" },
  { id: "p2", name: "Comunidade" },
];

describe("parseRevenuePaste", () => {
  it("lê o cabeçalho com meses, produto e origem em qualquer ordem", () => {
    const text = [
      "Descrição\tOrigem\tProduto\tJan\tFev\tMar",
      "Turma SP\tNova\tImersão Vendas\tR$ 1.000,00\t\t2.500,50",
    ].join("\n");
    const [r] = parseRevenuePaste(text, products, null);
    expect(r).toMatchObject({
      row: 2,
      description: "Turma SP",
      productId: "p1",
      origin: "nova",
      values: [
        { month: 1, amount: 1000 },
        { month: 3, amount: 2500.5 },
      ],
      errors: [],
    });
  });

  it("reconhece cabeçalho com poucos meses", () => {
    const rows = parseRevenuePaste(
      "Descrição\tOrigem\tJan\tFev\nA\tCarteira\t1\t2",
      products,
      null,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.values).toEqual([
      { month: 1, amount: 1 },
      { month: 2, amount: 2 },
    ]);
  });

  it("sem cabeçalho, os números depois da descrição são os meses a partir de janeiro", () => {
    const [r] = parseRevenuePaste("Contrato X\tCarteira\t100\t200", products, null);
    expect(r!.origin).toBe("carteira");
    expect(r!.values).toEqual([
      { month: 1, amount: 100 },
      { month: 2, amount: 200 },
    ]);
  });

  it("linha com mais de 12 números usa os 12 últimos e reconhece o produto entre os textos", () => {
    const nums = Array.from({ length: 12 }, (_, i) => String(i + 1));
    const [r] = parseRevenuePaste(
      ["Assinaturas", "Comunidade", ...nums].join("\t"),
      products,
      "nova",
    );
    expect(r!.productId).toBe("p2");
    expect(r!.origin).toBe("nova");
    expect(r!.values).toHaveLength(12);
    expect(r!.values[11]).toEqual({ month: 12, amount: 12 });
  });

  it("usa a origem padrão e aponta o que não reconhece", () => {
    const rows = parseRevenuePaste("A\tXPTO\t10\nB\tabc;", products, "renovacao");
    expect(rows[0]!.origin).toBe("renovacao");
    expect(rows[0]!.errors[0]).toMatch(/XPTO/);
    expect(rows[1]!.errors.length).toBeGreaterThan(0);
  });

  it("exige a origem quando não há padrão", () => {
    const [r] = parseRevenuePaste("A\t10", products, null);
    expect(r!.errors).toContain("Falta a origem (Carteira, Renovação ou Nova).");
  });
});
