import { describe, expect, it } from "vitest";
import { describeRule, uniqueKey, uniqueName, usedScopes } from "./parameters";

describe("uniqueKey", () => {
  it("gera a chave sem acentos nem símbolos", () => {
    expect(uniqueKey("IBS (estadual)", [])).toBe("ibs_estadual");
    expect(uniqueKey("Provisão de 13º", [])).toBe("provisao_de_13");
    expect(uniqueKey("  CBS  ", [])).toBe("cbs");
  });
  it("repetida ganha um número", () => {
    expect(uniqueKey("CBS", ["cbs"])).toBe("cbs_2");
    expect(uniqueKey("CBS", ["cbs", "cbs_2"])).toBe("cbs_3");
  });
  it("nome só com símbolos ainda gera uma chave", () => {
    expect(uniqueKey("%%%", [])).toBe("parametro");
  });
});

describe("uniqueName", () => {
  it("mantém o nome livre e numera o repetido, sem diferenciar acento", () => {
    expect(uniqueName("IBS", ["PIS"])).toBe("IBS");
    expect(uniqueName("Comissão", ["comissao"])).toBe("Comissão (2)");
    expect(uniqueName("Comissão", ["comissao", "Comissão (2)"])).toBe("Comissão (3)");
  });
});

describe("usedScopes", () => {
  it("lista os escopos que os valores usam", () => {
    const base = { unit_id: null, product_id: null, contract_type_id: null, revenue_type_id: null };
    expect(usedScopes([base])).toEqual(new Set());
    expect(
      usedScopes([
        { ...base, unit_id: "u" },
        { ...base, contract_type_id: "c" },
      ]),
    ).toEqual(new Set(["unit", "contract_type"]));
  });
});

describe("describeRule", () => {
  const lookups = {
    dreLine: (id: string) => ({ l1: "Impostos sobre a receita" })[id],
    revenueType: (id: string) => ({ t1: "Parceiros", t2: "Patrocínio" })[id],
    contractType: (id: string) => ({ c1: "CLT" })[id],
    account: (id: string) => ({ a1: "Aluguel" })[id],
  };
  const rule = {
    base_kind: "receita",
    target_dre_line_id: "l1",
    revenue_type_ids: null,
    exclude_revenue_type_ids: null,
    contract_type_ids: null,
    account_ids: null,
    active: true,
  };
  it("descreve a base e a linha da DRE", () => {
    expect(describeRule(rule, lookups)).toBe("Receita → Impostos sobre a receita");
  });
  it("inclui os filtros", () => {
    expect(describeRule({ ...rule, exclude_revenue_type_ids: ["t1"] }, lookups)).toBe(
      "Receita (exceto Parceiros) → Impostos sobre a receita",
    );
    expect(describeRule({ ...rule, revenue_type_ids: ["t2"] }, lookups)).toBe(
      "Receita (só Patrocínio) → Impostos sobre a receita",
    );
    expect(
      describeRule({ ...rule, base_kind: "salario", contract_type_ids: ["c1"] }, lookups),
    ).toBe("Remuneração das pessoas (só CLT) → Impostos sobre a receita");
  });
  it("avisa quando a regra está desativada", () => {
    expect(describeRule({ ...rule, active: false }, lookups)).toContain("regra desativada");
  });
});
