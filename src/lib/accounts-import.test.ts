import { describe, expect, it } from "vitest";
import {
  defaultDreLine,
  guessColumns,
  guessHasHeader,
  guessKind,
  parseTable,
  planAccounts,
  toImportRows,
  type ExistingAccount,
} from "./accounts-import";

const tsv = (...rows: string[][]) => rows.map((r) => r.join("\t")).join("\n");

describe("parseTable", () => {
  it("lê tabulação, ponto e vírgula e vírgula, e tira aspas", () => {
    expect(parseTable("a\tb\n1\t2")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
    expect(parseTable('"Código";"Nome"\n1.01;"Aluguel"')).toEqual([
      ["Código", "Nome"],
      ["1.01", "Aluguel"],
    ]);
    expect(parseTable("1.01,Aluguel")).toEqual([["1.01", "Aluguel"]]);
  });
  it("ignora linhas em branco", () => {
    expect(parseTable("a\tb\n\n  \n1\t2\n")).toHaveLength(2);
  });
});

describe("colunas", () => {
  it("acha cabeçalho e colunas pelos nomes", () => {
    const rows = parseTable(
      tsv(
        ["Código", "Descrição", "Tipo"],
        ["1.01", "Receita", "Receita"],
        ["2.01", "Aluguel", "Despesa"],
      ),
    );
    expect(guessHasHeader(rows)).toBe(true);
    expect(guessColumns(rows, true)).toEqual({ code: 0, name: 1, type: 2 });
  });
  it("acha colunas pelos dados quando não há cabeçalho", () => {
    const rows = parseTable(
      tsv(
        ["1.01", "Receita de serviços", "Receita"],
        ["2.01", "Aluguel", "Despesa"],
        ["2.02", "Energia", "Despesa"],
      ),
    );
    expect(guessHasHeader(rows)).toBe(false);
    expect(guessColumns(rows, false)).toEqual({ code: 0, name: 1, type: 2 });
  });
  it("funciona sem coluna de tipo", () => {
    const rows = parseTable(
      tsv(["Código da categoria", "Nome da categoria"], ["1.01", "Receita"], ["2.01", "Aluguel"]),
    );
    expect(guessColumns(rows, true)).toEqual({ code: 0, name: 1, type: null });
  });
  it("adivinha receita e despesa, mas não folha", () => {
    expect(guessKind("Receita")).toBe("receita");
    expect(guessKind("Entradas")).toBe("receita");
    expect(guessKind("(-) Despesa")).toBe("despesa");
    expect(guessKind("Saída")).toBe("despesa");
    expect(guessKind("Pessoal")).toBeNull();
    expect(guessKind("")).toBeNull();
  });
});

describe("toImportRows", () => {
  const rows = parseTable(
    tsv(
      ["Código", "Descrição", "Tipo"],
      ["1", "Receitas", "Receita"],
      ["1.01", "Serviços", "Receita"],
      ["2", "Despesas", "Despesa"],
      ["2.01", "Aluguel", "Despesa"],
      ["2.01", "Duplicado", "Despesa"],
      ["2.02", "", "Despesa"],
      ["9.99", "Solta", ""],
    ),
  );
  const out = toImportRows(rows, true, { code: 0, name: 1, type: 2 });

  it("marca como grupo a conta que tem subcontas", () => {
    expect(out.rows.map((r) => [r.code, r.isGroup])).toEqual([
      ["1", true],
      ["1.01", false],
      ["2", true],
      ["2.01", false],
      ["9.99", false],
    ]);
  });
  it("aponta código repetido e nome faltando, com a linha da planilha", () => {
    expect(out.errors.map((e) => e.line)).toEqual([6, 7]);
  });
  it("guarda o tipo adivinhado, ou null", () => {
    expect(out.rows.at(-1)!.kind).toBeNull();
    expect(out.rows[1]!.kind).toBe("receita");
  });
});

describe("planAccounts", () => {
  const existing: ExistingAccount[] = [
    {
      id: "a1",
      name: "Aluguel e condomínio",
      kind: "despesa",
      dre_line_id: "L-desp",
      omie_category_code: null,
    },
    {
      id: "a2",
      name: "Marketing",
      kind: "despesa",
      dre_line_id: "L-desp",
      omie_category_code: "2.05",
    },
    {
      id: "a3",
      name: "Receita de serviços",
      kind: "receita",
      dre_line_id: "L-rec",
      omie_category_code: null,
    },
    {
      id: "a4",
      name: "Despesas de produtos",
      kind: "despesa",
      dre_line_id: "L-prod",
      omie_category_code: null,
    },
  ];
  const row = (code: string, name: string, isGroup = false) => ({
    line: 1,
    code,
    name,
    kind: null,
    isGroup,
  });

  it("existente, vincular e criar", () => {
    const { items } = planAccounts(
      [
        row("2.05", "Marketing digital"),
        row("2.01", "Aluguel e Condomínio"),
        row("2.09", "Tarifas bancárias"),
      ],
      existing,
      { skipGroups: true },
    );
    expect(items.map((i) => [i.action, i.finalName, i.matchId])).toEqual([
      ["existente", "Marketing", "a2"],
      ["vincular", "Aluguel e condomínio", "a1"],
      ["criar", "Tarifas bancárias", null],
    ]);
  });

  it("nomes repetidos ganham o código", () => {
    const { items } = planAccounts([row("2.03", "Outros"), row("3.01", "Outros")], existing, {
      skipGroups: true,
    });
    expect(items.map((i) => i.finalName)).toEqual(["Outros (2.03)", "Outros (3.01)"]);
  });

  it("nome igual ao de uma conta que já tem outro código também ganha o código", () => {
    const { items } = planAccounts([row("7.01", "Marketing")], existing, { skipGroups: true });
    expect(items[0]).toMatchObject({ action: "criar", finalName: "Marketing (7.01)" });
  });

  it("repetido e sem código não tem como diferenciar: erro", () => {
    const { items, errors } = planAccounts([row("", "Brinde"), row("", "Brinde")], existing, {
      skipGroups: true,
    });
    expect(items).toHaveLength(1);
    expect(errors).toHaveLength(1);
  });

  it("ignora os grupos, a menos que se peça o contrário", () => {
    const rows = [row("2", "Despesas", true), row("2.01", "Energia")];
    expect(planAccounts(rows, existing, { skipGroups: true })).toMatchObject({ skippedGroups: 1 });
    expect(planAccounts(rows, existing, { skipGroups: true }).items).toHaveLength(1);
    expect(planAccounts(rows, existing, { skipGroups: false }).items).toHaveLength(2);
  });

  it("importar de novo não cria nada", () => {
    const first = planAccounts([row("2.09", "Tarifas bancárias")], existing, { skipGroups: true });
    const after: ExistingAccount[] = [
      ...existing,
      {
        id: "n1",
        name: first.items[0]!.finalName,
        kind: "despesa",
        dre_line_id: "L-desp",
        omie_category_code: "2.09",
      },
    ];
    const again = planAccounts([row("2.09", "Tarifas bancárias")], after, { skipGroups: true });
    expect(again.items.map((i) => i.action)).toEqual(["existente"]);
  });
});

describe("defaultDreLine", () => {
  it("usa a linha mais comum entre as contas do tipo", () => {
    const existing: ExistingAccount[] = [
      { id: "1", name: "a", kind: "despesa", dre_line_id: "L-prod", omie_category_code: null },
      { id: "2", name: "b", kind: "despesa", dre_line_id: "L-desp", omie_category_code: null },
      { id: "3", name: "c", kind: "despesa", dre_line_id: "L-desp", omie_category_code: null },
      { id: "4", name: "d", kind: "receita", dre_line_id: "L-rec", omie_category_code: null },
    ];
    expect(defaultDreLine(existing, "despesa")).toBe("L-desp");
    expect(defaultDreLine(existing, "receita")).toBe("L-rec");
    expect(defaultDreLine(existing, "folha")).toBeNull();
  });
});

import {
  enrichCategory,
  guessExtraColumns,
  isBeforeYear,
  matchKeyword,
  parseInclude,
  resolveUnit,
  splitPeriod,
  suggestGroup,
  suggestTreatment,
  type UnitInfo,
} from "./accounts-import";

describe("splitPeriod", () => {
  it("separa o ano do nome", () => {
    expect(splitPeriod("CUPOLA Summit Ingressos - 2027")).toEqual({
      baseName: "CUPOLA Summit Ingressos",
      period: "2027",
      startYear: 2027,
      endYear: 2027,
    });
  });
  it("aceita período de dois anos, com ano curto ou longo", () => {
    expect(splitPeriod("Insider Aluguel - 2026/2027")).toMatchObject({
      baseName: "Insider Aluguel",
      period: "2026/2027",
      startYear: 2026,
      endYear: 2027,
    });
    expect(splitPeriod("Insider Aluguel – 2026/27")).toMatchObject({
      period: "2026/2027",
      endYear: 2027,
    });
  });
  it("aceita o ano sem traço, mas só com 20xx no fim", () => {
    expect(splitPeriod("Summit Patrocínio 2026")).toMatchObject({
      baseName: "Summit Patrocínio",
      period: "2026",
    });
    expect(splitPeriod("Plano 1999")).toMatchObject({ period: null });
  });
  it("nome sem ano fica como está", () => {
    expect(splitPeriod("Aluguel e condomínio")).toEqual({
      baseName: "Aluguel e condomínio",
      period: null,
      startYear: null,
      endYear: null,
    });
    expect(splitPeriod("2027")).toMatchObject({ period: null, baseName: "2027" });
  });
  it("duas edições da mesma categoria têm a mesma base", () => {
    expect(splitPeriod("Summit Ingressos - 2026").baseName).toBe(
      splitPeriod("Summit Ingressos - 2027").baseName,
    );
  });
});

describe("isBeforeYear", () => {
  it("descarta o que termina antes do ano mínimo", () => {
    expect(isBeforeYear(splitPeriod("X - 2025"), 2026)).toBe(true);
    expect(isBeforeYear(splitPeriod("X - 2025/2026"), 2026)).toBe(false);
    expect(isBeforeYear(splitPeriod("X - 2026"), 2026)).toBe(false);
    expect(isBeforeYear(splitPeriod("X sem ano"), 2026)).toBe(false);
  });
});

describe("matchKeyword", () => {
  it("vale como palavra inteira, sem acento nem maiúscula, com plural simples", () => {
    expect(matchKeyword("ISS sobre serviços", "iss")).toBe(true);
    expect(matchKeyword("Mission statement", "iss")).toBe(false);
    expect(matchKeyword("Transferências entre contas", "Transferência")).toBe(true);
    expect(matchKeyword("Adiantamento de clientes - 2027", "Adiantamento de cliente")).toBe(true);
    expect(matchKeyword("Simples Nacional", "simples")).toBe(true);
    expect(matchKeyword("Despesa", "")).toBe(false);
  });
});

describe("regras de tratamento e grupo", () => {
  const treatment = [
    { keyword: "INSS", treatment: "calculada" },
    { keyword: "Transferência", treatment: "fora_dre" },
    { keyword: "INSS patronal", treatment: "fora_dre" },
  ];
  it("sugere o tratamento, preferindo a palavra mais específica", () => {
    expect(suggestTreatment("INSS sobre folha", treatment)).toEqual({
      treatment: "calculada",
      keyword: "INSS",
    });
    expect(suggestTreatment("INSS patronal 2027", treatment)).toEqual({
      treatment: "fora_dre",
      keyword: "INSS patronal",
    });
    expect(suggestTreatment("Aluguel", treatment)).toBeNull();
  });
  it("sugere o grupo", () => {
    const groups = [
      { keyword: "Summit", group_name: "Summit" },
      { keyword: "Insider Aluguel", group_name: "Insider Aluguel" },
    ];
    expect(suggestGroup("CUPOLA Summit Ingressos - 2027", groups)).toBe("Summit");
    expect(suggestGroup("Insider Aluguel - 2026/2027", groups)).toBe("Insider Aluguel");
    expect(suggestGroup("Marketing", groups)).toBeNull();
  });
});

describe("resolveUnit", () => {
  const units: UnitInfo[] = [
    { id: "u-cons", name: "Consultoria", omie_department_code: "D-10", name_keywords: null },
    { id: "u-edu", name: "Educação", omie_department_code: null, name_keywords: ["Summit"] },
    { id: "u-ag", name: "Agência", omie_department_code: null, name_keywords: null },
  ];
  it("o departamento do Omie vence (pelo código ou pelo nome da unidade)", () => {
    expect(resolveUnit("D-10", "Qualquer coisa", units)).toMatchObject({
      unitId: "u-cons",
      source: "departamento",
    });
    expect(resolveUnit("educacao", "Qualquer coisa", units)).toMatchObject({
      unitId: "u-edu",
      source: "departamento",
    });
  });
  it("departamento que não corresponde a nenhuma unidade é apontado", () => {
    expect(resolveUnit("Marte", "Summit", units)).toMatchObject({
      unitId: null,
      unknownDepartment: true,
    });
  });
  it("sem departamento, usa o nome da categoria (nome ou palavra da unidade)", () => {
    expect(resolveUnit(undefined, "Consultoria Receita Fixa - 2027", units)).toMatchObject({
      unitId: "u-cons",
      source: "nome",
    });
    expect(resolveUnit("", "CUPOLA Summit Ingressos - 2027", units)).toMatchObject({
      unitId: "u-edu",
      source: "nome",
    });
  });
  it("nome que combina com mais de uma unidade não escolhe nenhuma", () => {
    expect(resolveUnit(undefined, "Summit com Consultoria", units)).toMatchObject({
      unitId: null,
      ambiguous: true,
    });
  });
  it("sem pista nenhuma, fica para todas as unidades", () => {
    expect(resolveUnit(undefined, "Material de escritório", units)).toMatchObject({
      unitId: null,
      ambiguous: false,
      source: null,
    });
  });
});

describe("parseInclude e colunas extras", () => {
  it("lê sim e não", () => {
    expect(parseInclude("Sim")).toBe(true);
    expect(parseInclude("NÃO")).toBe(false);
    expect(parseInclude("")).toBeNull();
    expect(parseInclude("talvez")).toBeNull();
  });
  it("acha as colunas pelo cabeçalho", () => {
    const rows = parseTable(
      tsv(
        ["Categoria", "Tipo", "Departamento", "Grupo", "Importar?"],
        ["X - 2027", "Receita", "Educação", "Summit", "sim"],
      ),
    );
    expect(guessExtraColumns(rows, true, [0, 1])).toEqual({ department: 2, group: 3, include: 4 });
    expect(guessExtraColumns(rows, false, [])).toEqual({});
  });
});

describe("enrichCategory", () => {
  const ctx = {
    minYear: 2026,
    treatmentRules: [{ keyword: "ISS", treatment: "calculada" }],
    groupRules: [{ keyword: "Summit", group_name: "Summit" }],
    units: [
      { id: "u-edu", name: "Educação", omie_department_code: null, name_keywords: ["Summit"] },
    ] as UnitInfo[],
  };
  it("junta período, grupo, unidade e tratamento", () => {
    const e = enrichCategory({ name: "CUPOLA Summit Ingressos - 2027" }, ctx);
    expect(e).toMatchObject({
      baseName: "CUPOLA Summit Ingressos",
      period: "2027",
      group: "Summit",
      treatment: "lancavel",
      excluded: null,
    });
    expect(e.unit).toMatchObject({ unitId: "u-edu", source: "nome" });
  });
  it("marca o que não entra: período anterior e marcada com não", () => {
    expect(enrichCategory({ name: "Algo - 2025" }, ctx).excluded).toBe("periodo_anterior");
    expect(enrichCategory({ name: "Algo - 2027", includeFlag: false }, ctx).excluded).toBe(
      "marcada_nao",
    );
    // a marcação manual vence o período
    expect(enrichCategory({ name: "Algo - 2025", includeFlag: false }, ctx).excluded).toBe(
      "marcada_nao",
    );
    // "sim" não anula o período anterior: o ano mínimo é uma regra de negócio
    expect(enrichCategory({ name: "Algo - 2025", includeFlag: true }, ctx).excluded).toBe(
      "periodo_anterior",
    );
  });
  it("sugere tratamento calculada e a palavra que decidiu", () => {
    expect(enrichCategory({ name: "ISS sobre serviços" }, ctx)).toMatchObject({
      treatment: "calculada",
      treatmentKeyword: "ISS",
    });
  });
  it("a coluna de grupo da planilha vence a regra", () => {
    expect(
      enrichCategory({ name: "CUPOLA Summit Ingressos - 2027", groupHint: "Eventos" }, ctx).group,
    ).toBe("Eventos");
  });
});
