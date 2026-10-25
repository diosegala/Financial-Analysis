import { describe, expect, it } from "vitest";
import { matchAccount, planFromActuals, type MatchableAccount } from "./omie";

const acc = (over: Partial<MatchableAccount> & { name: string }): MatchableAccount => ({
  id: over.name,
  base_name: null,
  period: null,
  treatment: "lancavel",
  kind: "despesa",
  active: true,
  ...over,
});

describe("matchAccount", () => {
  const accounts = [
    acc({ name: "Marketing" }),
    acc({ name: "CUPOLA Summit Custos - 2026", base_name: "CUPOLA Summit Custos", period: "2026" }),
    acc({ name: "CUPOLA Summit Custos - 2027", base_name: "CUPOLA Summit Custos", period: "2027" }),
    acc({ name: "INSS", treatment: "calculada" }),
    acc({ name: "Antiga", active: false }),
  ];

  it("acha pelo nome, sem diferenciar acento ou caixa", () => {
    expect(matchAccount("marketing", accounts, 2027)).toMatchObject({ status: "conta" });
  });
  it("leva a categoria de 2026 para a conta de 2027 pelo nome sem o período", () => {
    for (const name of ["CUPOLA Summit Custos - 2026", "CUPOLA Summit Custos - 2025"]) {
      const m = matchAccount(name, accounts, 2027);
      expect(m.status === "conta" && m.account.name).toBe("CUPOLA Summit Custos - 2027");
    }
  });
  it("avisa quando a conta é calculada pelo app", () => {
    expect(matchAccount("INSS", accounts, 2027)).toMatchObject({ status: "calculada" });
  });
  it("não usa conta arquivada nem inexistente", () => {
    expect(matchAccount("Antiga", accounts, 2027)).toEqual({ status: "sem_conta" });
    expect(matchAccount("Viagem", accounts, 2027)).toEqual({ status: "sem_conta" });
  });
});

describe("planFromActuals", () => {
  const actual = [100, 200, 0, 0, 0, 0, 0, 0, 0, 0, 0, 100];
  it("repete o mês a mês com participação e reajuste", () => {
    expect(planFromActuals(actual, 0.5, 0.1, "mes_a_mes")).toEqual([
      { month: 1, amount: 55 },
      { month: 2, amount: 110 },
      { month: 12, amount: 55 },
    ]);
  });
  it("distribui a média nos 12 meses", () => {
    const r = planFromActuals(actual, 1, 0, "media");
    expect(r).toHaveLength(12);
    expect(r[0]!.amount).toBeCloseTo(33.33, 2);
  });
});
