import { describe, expect, it } from "vitest";
import {
  aggregateExpenses,
  aggregateReceipts,
  itemOf,
  split,
  yearsToRead,
} from "../../supabase/functions/omie-sync/aggregate";

const paid = (d: Record<string, unknown>, value: number) => ({
  detalhes: { dDtPagamento: "10/03/2026", ...d },
  resumo: { nValPago: value },
});

describe("leitura do Omie", () => {
  it("tira o nome do item da observação do título", () => {
    expect(itemOf("Figma||14/03 FIGMA USD60")).toBe("Figma");
    expect(itemOf("Nekt - CY7SCCNQ-0001")).toBe("Nekt");
    expect(itemOf("Conta a Pagar gerada pelo app")).toBe("");
    expect(itemOf(null)).toBe("");
  });

  it("reparte pelas categorias e pelos departamentos", () => {
    const out = split(
      [
        { codigo_categoria: "A", valor: 75 },
        { codigo_categoria: "B", valor: 25 },
      ],
      [
        { cCodDep: "1", nPerDep: 50 },
        { cCodDep: "2", nPerDep: 50 },
      ],
      200,
    );
    expect(out).toEqual([
      ["A", "1", 75],
      ["A", "2", 75],
      ["B", "1", 25],
      ["B", "2", 25],
    ]);
  });

  it("despesas: conta pagamento de título e extrato, sem baixa, transferência ou outro ano", () => {
    const titles = [
      {
        codigo_lancamento_omie: 9,
        codigo_cliente_fornecedor: 7,
        observacao: "Figma||x",
        status_titulo: "PAGO",
        categorias: [{ codigo_categoria: "A", valor: 100 }],
        data_vencimento: "10/03/2026",
      },
    ];
    const rows = aggregateExpenses(
      [
        paid({ cGrupo: "CONTA_A_PAGAR", nCodTitulo: 9 }, 100),
        paid({ cGrupo: "CONTA_CORRENTE_PAG", cCodCateg: "B", nCodCliente: 3 }, 40),
        paid({ cGrupo: "CONTA_CORRENTE_PAG", cOrigem: "BAXP", cCodCateg: "B" }, 999),
        paid({ cGrupo: "CONTA_CORRENTE_PAG", cOrigem: "TRAP", cCodCateg: "B" }, 999),
        paid({ cGrupo: "CONTA_A_PAGAR", nCodTitulo: 9, dDtPagamento: "10/03/2025" }, 999),
      ],
      titles,
      [2026],
    );
    expect(rows).toEqual([
      {
        year: 2026,
        month: 3,
        category_code: "A",
        department_code: "",
        supplier_code: "7",
        item: "Figma",
        amount_paid: 100,
        amount_open: 0,
      },
      {
        year: 2026,
        month: 3,
        category_code: "B",
        department_code: "",
        supplier_code: "3",
        item: "",
        amount_paid: 40,
        amount_open: 0,
      },
    ]);
  });

  it("em aberto: títulos pelo vencimento, sem pagos e cancelados", () => {
    const base = { codigo_categoria: "A", valor_documento: 50, data_vencimento: "05/11/2026" };
    const expenses = aggregateExpenses(
      [],
      [
        { ...base, status_titulo: "A VENCER" },
        { ...base, status_titulo: "CANCELADO" },
        { ...base, status_titulo: "PAGO" },
      ],
      [2026],
    );
    expect(expenses).toHaveLength(1);
    expect(expenses[0]).toMatchObject({ month: 11, amount_open: 50, amount_paid: 0 });
    const receipts = aggregateReceipts(
      [],
      [
        { ...base, status_titulo: "ATRASADO" },
        { ...base, status_titulo: "RECEBIDO" },
      ],
      [2026],
    );
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({ month: 11, amount_open: 50, amount_received: 0 });
  });

  it("lê o ano atual e o seguinte; até março, também o anterior", () => {
    expect(yearsToRead(new Date("2026-11-05T12:00:00Z"))).toEqual([2026, 2027]);
    expect(yearsToRead(new Date("2027-02-10T12:00:00Z"))).toEqual([2026, 2027, 2028]);
  });
});
