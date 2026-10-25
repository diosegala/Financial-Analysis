import { describe, expect, it } from "vitest";
import { parseDate, parseNames, parsePeople, type PeopleCatalog } from "./people-import";

const catalog: PeopleCatalog = {
  units: [
    { id: "u-ag", name: "Agência", name_keywords: null },
    { id: "u-ed", name: "Educação", name_keywords: null },
    { id: "u-fin", name: "Financeiro", name_keywords: ["Finanças"] },
  ],
  contractTypes: [
    { id: "clt", name: "CLT", active: true, sort_order: 1, role_keywords: null },
    {
      id: "est",
      name: "Estagiário (CIEE)",
      active: true,
      sort_order: 2,
      role_keywords: ["estagio"],
    },
    { id: "old", name: "Antigo", active: false, sort_order: 0, role_keywords: null },
  ],
};
const tsv = (...rows: string[][]) => rows.map((r) => r.join("\t")).join("\n");

describe("parseDate", () => {
  it("lê número de série do Excel", () => {
    expect(parseDate("45355")).toBe("2024-03-04");
    expect(parseDate("45355.0")).toBe("2024-03-04");
  });
  it("lê dd/mm/aaaa e aaaa-mm-dd", () => {
    expect(parseDate("04/03/2024")).toBe("2024-03-04");
    expect(parseDate("2024-03-04")).toBe("2024-03-04");
  });
  it("recusa data que não existe", () => {
    expect(parseDate("31/02/2024")).toBeNull();
    expect(parseDate("abc")).toBeNull();
  });
});

describe("parsePeople", () => {
  it("lê a planilha de cinco colunas, com cabeçalho e linha de total", () => {
    const r = parsePeople(
      tsv(
        ["ID Colaborador", "Data Admissao", "Cargo", "Equipe", "Salário"],
        ["1", "45355", "ANALISTA DE CONTEÚDO PLENO", "AGÊNCIA", "5.000,00"],
        ["2", "15/03/2021", "Coordenadora", "EDUCAÇÃO", "7000"],
        ["", "", "", "", "12.000,00"],
      ),
      catalog,
    );
    expect(r.errors).toEqual([]);
    expect(r.ignored).toBe(1);
    expect(r.rows).toHaveLength(2);
    expect(r.rows[0]).toMatchObject({
      external_id: "1",
      hire_date: "2024-03-04",
      unit_id: "u-ag",
      contract_type_id: "clt",
      salary: 5000,
    });
    expect(r.rows[1]).toMatchObject({ unit_id: "u-ed", hire_date: "2021-03-15", salary: 7000 });
  });

  it("sugere estagiário pelo cargo e deixa o resto no primeiro vínculo ativo", () => {
    const r = parsePeople(
      tsv(["7", "", "Estagio Desing", "Agência", "1500"], ["8", "", "Designer", "Agência", "4000"]),
      catalog,
    );
    expect(r.rows.map((p) => p.contract_type_id)).toEqual(["est", "clt"]);
  });

  it("usa a coluna de vínculo quando ela vem preenchida", () => {
    const r = parsePeople(
      tsv(["7", "", "Designer", "Agência", "1500", "Estagiário (CIEE)"]),
      catalog,
    );
    expect(r.rows[0]!.contract_type_id).toBe("est");
    expect(
      parsePeople(tsv(["7", "", "x", "Agência", "1", "Sócio"]), catalog).errors[0]!.message,
    ).toMatch(/vínculo/);
  });

  it("acha a unidade pelas palavras da unidade", () => {
    expect(parsePeople(tsv(["3", "", "x", "FINANÇAS", "1000"]), catalog).rows[0]!.unit_id).toBe(
      "u-fin",
    );
  });

  it("aponta equipe desconhecida, salário inválido, data inválida e ID repetido", () => {
    const r = parsePeople(
      tsv(
        ["1", "", "x", "Marte", "1000"],
        ["2", "", "x", "Agência", "abc"],
        ["3", "99/99/2020", "x", "Agência", "1000"],
        ["4", "", "x", "Agência", "1000"],
        ["4.0", "", "x", "Agência", "1000"],
      ),
      catalog,
    );
    expect(r.rows).toHaveLength(1);
    expect(r.errors.map((e) => e.line)).toEqual([1, 2, 3, 5]);
  });
});

describe("parseNames", () => {
  it("lê ID e nome, com cabeçalho, e aponta linhas incompletas e IDs repetidos", () => {
    const r = parseNames(
      tsv(
        ["ID Colaborador", "Nome"],
        ["1", "Ana Souza"],
        ["2.0", "Bruno Lima"],
        ["3", ""],
        ["1", "Outra"],
      ),
    );
    expect(r.rows).toEqual([
      { line: 2, external_id: "1", name: "Ana Souza" },
      { line: 3, external_id: "2", name: "Bruno Lima" },
    ]);
    expect(r.errors.map((e) => e.line)).toEqual([4, 5]);
  });
  it("aceita ponto e vírgula", () => {
    expect(parseNames("7;Carla Dias").rows[0]).toMatchObject({
      external_id: "7",
      name: "Carla Dias",
    });
  });
});
