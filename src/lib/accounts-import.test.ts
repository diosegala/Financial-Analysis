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
