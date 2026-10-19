import { describe, expect, it } from "vitest";
import { MONTHS } from "./format";
import { contractPlan, describePlan, describePrice } from "./products";
import { parseProducts } from "./products-import";

const terms = (
  price: number,
  price_model: "mensal" | "total" | "unico",
  duration_months: number | null,
) => ({
  price,
  price_model,
  duration_months,
});

describe("contractPlan", () => {
  it("mensal: o preço em cada mês do prazo", () => {
    const p = contractPlan(terms(5000, "mensal", 6), 3);
    expect(p.schedule.map((m) => m.month)).toEqual([3, 4, 5, 6, 7, 8]);
    expect(p.schedule.every((m) => m.amount === 5000)).toBe(true);
    expect(p.contractTotal).toBe(30000);
    expect(p.yearTotal).toBe(30000);
    expect(p.monthsAfterYear).toBe(0);
  });

  it("mensal: o que passa de dezembro fica de fora, mas conta no contrato", () => {
    const p = contractPlan(terms(1000, "mensal", 12), 10);
    expect(p.schedule.map((m) => m.month)).toEqual([10, 11, 12]);
    expect(p.yearTotal).toBe(3000);
    expect(p.contractTotal).toBe(12000);
    expect(p.monthsAfterYear).toBe(9);
  });

  it("total: divide o contrato igualmente e a sobra de centavos vai para o último mês", () => {
    const p = contractPlan(terms(10000, "total", 3), 1);
    expect(p.schedule.map((m) => m.amount)).toEqual([3333.33, 3333.33, 3333.34]);
    expect(p.yearTotal).toBe(10000);
  });

  it("total: contrato maior que o ano lança só a parte que cai nele", () => {
    const p = contractPlan(terms(24000, "total", 12), 7);
    expect(p.schedule).toHaveLength(6);
    expect(p.schedule[0]!.amount).toBe(2000);
    expect(p.yearTotal).toBe(12000);
    expect(p.contractTotal).toBe(24000);
  });

  it("único: tudo no mês de início, mesmo que o produto tenha prazo", () => {
    const p = contractPlan(terms(15000, "unico", 4), 5);
    expect(p.schedule).toEqual([{ month: 5, amount: 15000 }]);
    expect(p.months).toBe(1);
  });

  it("sem prazo, vale até dezembro", () => {
    const p = contractPlan(terms(800, "mensal", null), 9);
    expect(p.schedule.map((m) => m.month)).toEqual([9, 10, 11, 12]);
  });

  it("aceita trocar preço e prazo na hora de lançar", () => {
    const p = contractPlan(terms(5000, "mensal", 6), 1, { price: 4500, months: 2 });
    expect(p.schedule).toEqual([
      { month: 1, amount: 4500 },
      { month: 2, amount: 4500 },
    ]);
  });

  it("produto sem preço lança zero", () => {
    const p = contractPlan({ price: null, price_model: "mensal", duration_months: 3 }, 1);
    expect(p.yearTotal).toBe(0);
  });
});

// O Intl usa espaço não separável depois de "R$"; os textos são comparados com espaço comum.
const plain = (s: string) => s.replaceAll("\u00a0", " ");

describe("textos", () => {
  it("descreve o preço do produto", () => {
    expect(plain(describePrice({ kind: "servico", ...terms(5000, "mensal", 6) }))).toBe(
      "R$ 5.000/mês · 6 meses",
    );
    expect(plain(describePrice({ kind: "servico", ...terms(30000, "total", 1) }))).toBe(
      "R$ 30.000 no contrato · 1 mês",
    );
    expect(plain(describePrice({ kind: "servico", ...terms(15000, "unico", null) }))).toBe(
      "R$ 15.000 (pagamento único)",
    );
    expect(plain(describePrice({ kind: "evento", ...terms(500, "mensal", null) }))).toBe(
      "R$ 500 por participante",
    );
    expect(
      describePrice({ kind: "servico", price: null, price_model: "mensal", duration_months: null }),
    ).toBe("Sem preço");
  });

  it("resume o contrato lançado", () => {
    expect(plain(describePlan(contractPlan(terms(5000, "mensal", 6), 3), [...MONTHS]))).toBe(
      "6 × R$ 5.000 = R$ 30.000 (Mar–Ago)",
    );
    expect(plain(describePlan(contractPlan(terms(1000, "mensal", 12), 10), [...MONTHS]))).toBe(
      "3 × R$ 1.000 = R$ 3.000 (Out–Dez) · 9 meses caem no ano seguinte",
    );
  });
});

describe("parseProducts", () => {
  const catalog = {
    units: [
      { id: "u-cons", name: "Consultoria" },
      { id: "u-ag", name: "Agência" },
      { id: "u-edu", name: "Educação" },
    ],
    revenueTypes: [
      { id: "t-12", name: "Recorrente 12 meses" },
      { id: "t-edu", name: "Educação" },
    ],
  };
  const tsv = (...rows: string[][]) => rows.map((r) => r.join("\t")).join("\n");

  it("lê serviço e evento, com ou sem cabeçalho e acentos", () => {
    const r = parseProducts(
      tsv(
        [
          "Nome",
          "Unidade",
          "Tipo",
          "Tipo de receita",
          "Preço",
          "Cobrança",
          "Prazo",
          "Vagas",
          "Custo",
          "Fixo",
        ],
        [
          "Diagnóstico",
          "consultoria",
          "serviço",
          "Recorrente 12 meses",
          "5.000,00",
          "mês",
          "6",
          "",
          "",
          "",
        ],
        [
          "Treinamento X",
          "EDUCACAO",
          "treinamento",
          "Educação",
          "500",
          "",
          "",
          "20",
          "100",
          "2.000",
        ],
      ),
      catalog,
    );
    expect(r.errors).toEqual([]);
    expect(r.rows).toHaveLength(2);
    expect(r.rows[0]).toMatchObject({
      unit_id: "u-cons",
      kind: "servico",
      price: 5000,
      price_model: "mensal",
      duration_months: 6,
    });
    expect(r.rows[1]).toMatchObject({
      unit_id: "u-edu",
      kind: "evento",
      price: 500,
      default_seats: 20,
      cost_per_participant: 100,
      fixed_cost: 2000,
      duration_months: null,
    });
  });

  it("aceita unidade em branco como todas as unidades", () => {
    const r = parseProducts(tsv(["Palestra", "", "evento"]), catalog);
    expect(r.rows[0]!.unit_id).toBeNull();
  });

  it("aponta cada problema com a linha", () => {
    const r = parseProducts(
      tsv(
        ["Sem unidade", "Marte", "serviço"],
        ["", "Agência"],
        ["Tipo ruim", "Agência", "coisa"],
        ["Preço ruim", "Agência", "serviço", "", "abc"],
        ["Prazo ruim", "Agência", "serviço", "", "100", "mês", "2,5"],
        ["Evento com cobrança", "Educação", "evento", "", "100", "total"],
        ["Repetido", "Agência"],
        ["repetido", "Agência"],
      ),
      catalog,
    );
    expect(r.rows.map((x) => x.name)).toEqual(["Repetido"]);
    expect(r.errors.map((e) => e.line)).toEqual([1, 2, 3, 4, 5, 6, 8]);
    expect(r.errors[0]!.message).toContain("Marte");
    expect(r.errors[3]!.message).toContain("preço");
  });
});
