import { describe, expect, it } from "vitest";
import { summarizeEvent, standardItems, type EventItem } from "./events";

const item = (
  kind: EventItem["kind"],
  accountId: string,
  total: number,
  revenueTypeId: string | null = null,
): EventItem => ({
  eventId: "e1",
  kind,
  accountId,
  revenueTypeId,
  total,
});

describe("summarizeEvent", () => {
  const items = [
    item("receita", "a-ingr", 30000, "t-ingr"),
    item("receita", "a-ingr", 10000, "t-ingr"),
    item("receita", "a-patr", 60000, "t-patr"),
    item("despesa", "c-local", 20000),
    item("despesa", "c-comida", 15000),
    item("despesa", "c-local", 5000),
  ];
  const s = summarizeEvent(items);

  it("soma receita, custo e resultado", () => {
    expect(s.receita).toBe(100000);
    expect(s.custo).toBe(40000);
    expect(s.resultado).toBe(60000);
    expect(s.margem).toBeCloseTo(0.6);
  });
  it("separa a receita por origem (tipo de receita)", () => {
    expect(s.porOrigem.get("t-ingr")).toBe(40000);
    expect(s.porOrigem.get("t-patr")).toBe(60000);
  });
  it("separa o custo por categoria (conta)", () => {
    expect(s.porCategoria.get("c-local")).toBe(25000);
    expect(s.porCategoria.get("c-comida")).toBe(15000);
  });
  it("evento sem receita não tem margem e o resultado é negativo", () => {
    const only = summarizeEvent([item("despesa", "c", 1000)]);
    expect(only.margem).toBeNull();
    expect(only.resultado).toBe(-1000);
  });
  it("evento vazio zera tudo", () => {
    expect(summarizeEvent([])).toMatchObject({ receita: 0, custo: 0, resultado: 0, margem: null });
  });
});

describe("standardItems", () => {
  const fmt = (n: number) => `R$ ${n}`;
  it("cria ingressos e custos a partir do produto", () => {
    const items = standardItems(
      { default_seats: 20, price: 500, cost_per_participant: 100, fixed_cost: 2000 },
      fmt,
    );
    expect(items).toEqual([
      { kind: "receita", description: "Ingressos (20 × R$ 500)", amount: 10000 },
      { kind: "despesa", description: "Custo por participante (20 × R$ 100)", amount: 2000 },
      { kind: "despesa", description: "Custo fixo do evento", amount: 2000 },
    ]);
  });
  it("só cria o que o produto informa", () => {
    expect(
      standardItems(
        { default_seats: null, price: null, cost_per_participant: null, fixed_cost: 800 },
        fmt,
      ),
    ).toEqual([{ kind: "despesa", description: "Custo fixo do evento", amount: 800 }]);
    expect(
      standardItems(
        { default_seats: null, price: null, cost_per_participant: null, fixed_cost: null },
        fmt,
      ),
    ).toEqual([]);
    // sem vagas não há como multiplicar preço nem custo por participante
    expect(
      standardItems(
        { default_seats: null, price: 500, cost_per_participant: 100, fixed_cost: null },
        fmt,
      ),
    ).toEqual([]);
  });
});
