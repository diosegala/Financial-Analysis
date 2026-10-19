import { describe, expect, it } from "vitest";
import { salaryFor, type SalaryChange } from "./payroll";
import { adjustFrom, monthRange } from "./plan-data";

const change = (month: number, new_salary: number) => ({ month, new_salary }) as SalaryChange;

describe("salaryFor", () => {
  const ana = {
    base_salary: 5000,
    start_month: null,
    end_month: null,
    salary_changes: [change(7, 6000)],
  };

  it("usa o salário base antes do reajuste", () => {
    expect(salaryFor(ana, 6)).toBe(5000);
  });
  it("usa o reajuste a partir do mês", () => {
    expect(salaryFor(ana, 7)).toBe(6000);
    expect(salaryFor(ana, 12)).toBe(6000);
  });
  it("aplica o reajuste mais recente até o mês", () => {
    const bia = { ...ana, salary_changes: [change(10, 7000), change(4, 5500)] };
    expect(salaryFor(bia, 3)).toBe(5000);
    expect(salaryFor(bia, 5)).toBe(5500);
    expect(salaryFor(bia, 11)).toBe(7000);
  });
  it("é zero fora do período de entrada e saída", () => {
    const caio = { ...ana, start_month: 3, end_month: 8 };
    expect(salaryFor(caio, 2)).toBe(0);
    expect(salaryFor(caio, 3)).toBe(5000);
    expect(salaryFor(caio, 8)).toBe(6000);
    expect(salaryFor(caio, 9)).toBe(0);
  });
});

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
