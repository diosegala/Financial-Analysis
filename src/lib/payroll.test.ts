import { describe, expect, it } from "vitest";
import { adjustFrom, monthRange } from "./plan-data";
import { groupBreakdown, type PayrollDetailRow } from "./payroll";

describe("helpers da grade", () => {
  it("monthRange corta em dezembro", () => {
    expect(monthRange(1, 3)).toEqual([1, 2, 3]);
    expect(monthRange(11, 6)).toEqual([11, 12]);
    expect(monthRange(5, 0)).toEqual([]);
  });
  it("adjustFrom reajusta só a partir do mês", () => {
    const values = new Map([
      [1, 100],
      [6, 100],
      [7, 200],
    ]);
    expect(adjustFrom(values, 6, 0.1)).toEqual([
      { month: 6, amount: 110 },
      { month: 7, amount: 220 },
    ]);
  });
});

describe("folha aberta por pessoa", () => {
  const rows: PayrollDetailRow[] = [
    { person_id: "a", month: 1, grupo: "bruto", item: "Salário bruto", amount: 5000 },
    { person_id: "a", month: 1, grupo: "retencao", item: "INSS do empregado", amount: 500 },
    { person_id: "a", month: 1, grupo: "retencao", item: "IRRF", amount: 100 },
    { person_id: "a", month: 1, grupo: "liquido", item: "Salário líquido", amount: 4400 },
    { person_id: "a", month: 1, grupo: "encargo", item: "FGTS", amount: 400 },
    { person_id: "a", month: 1, grupo: "custo_total", item: "Custo total", amount: 5400 },
    { person_id: "b", month: 2, grupo: "custo_total", item: "Custo total", amount: 3000 },
  ];
  it("agrupa por grupo sem repetir o bruto, na ordem da folha", () => {
    const { byPerson, totalCost } = groupBreakdown(rows, "grupo");
    const a = byPerson.get("a")!;
    expect(a.map((l) => l.label)).toEqual([
      "INSS e IRRF do empregado",
      "Salário líquido",
      "Encargos patronais",
      "Custo total",
    ]);
    expect(a[0]?.months[0]).toBe(600);
    expect(totalCost.slice(0, 2)).toEqual([5400, 3000]);
  });
  it("item a item soma igual ao resumo", () => {
    const sum = (mode: "grupo" | "item") =>
      groupBreakdown(rows, mode)
        .byPerson.get("a")!
        .reduce((t, l) => t + (l.months[0] ?? 0), 0);
    expect(groupBreakdown(rows, "item").byPerson.get("a")!.length).toBe(5);
    expect(sum("item")).toBe(sum("grupo"));
  });
});
