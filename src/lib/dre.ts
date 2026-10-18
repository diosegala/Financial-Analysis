// Pure DRE calculation engine (no I/O). Months are 1..12 of a given year.

export type ParamName = "imposto" | "comissao_comercial" | "comissao_parceiro" | "encargos";

export interface Parameter {
  name: ParamName;
  value: number; // fraction, e.g. 0.15 = 15%
  validFrom: string; // ISO date yyyy-mm-dd
}

/** Value in force on the first day of the given month; latest validFrom <= that date wins. */
export function paramFor(params: Parameter[], name: ParamName, year: number, month: number): number {
  const ref = `${year}-${String(month).padStart(2, "0")}-01`;
  const hit = params
    .filter((p) => p.name === name && p.validFrom <= ref)
    .sort((a, b) => (a.validFrom < b.validFrom ? 1 : -1))[0];
  return hit ? hit.value : 0;
}

export interface MonthInputs {
  receitaComercial: number; // revenue subject to commercial commission
  receitaParceiro: number; // revenue subject to partner commission
  despesasProdutos: number;
  folhaBase: number; // salaries / pró-labore / CIEE
  beneficios: number;
  rescisoes: number;
  despesas: number;
}

export interface Scenario {
  receitaPct: number; // e.g. 0.1 = +10%
  despesaPct: number;
}

export const REALISTA: Scenario = { receitaPct: 0, despesaPct: 0 };

export interface DreMonth {
  receitaBruta: number;
  despesasProdutos: number;
  custosIndiretos: number;
  despesas: number;
  comissionamento: number;
  impostos: number;
  contribuicaoLiquida: number;
  mcl: number; // fraction of receita bruta
}

export function computeMonth(
  input: MonthInputs,
  params: Parameter[],
  year: number,
  month: number,
  scenario: Scenario = REALISTA,
): DreMonth {
  const r = 1 + scenario.receitaPct;
  const d = 1 + scenario.despesaPct;
  const recCom = input.receitaComercial * r;
  const recPar = input.receitaParceiro * r;
  const receitaBruta = recCom + recPar;
  const encargos = input.folhaBase * paramFor(params, "encargos", year, month);
  const custosIndiretos = (input.folhaBase + encargos + input.beneficios + input.rescisoes) * d;
  const despesasProdutos = input.despesasProdutos * d;
  const despesas = input.despesas * d;
  const comissionamento =
    recCom * paramFor(params, "comissao_comercial", year, month) +
    recPar * paramFor(params, "comissao_parceiro", year, month);
  const impostos = receitaBruta * paramFor(params, "imposto", year, month);
  const contribuicaoLiquida =
    receitaBruta - despesasProdutos - custosIndiretos - despesas - comissionamento - impostos;
  return {
    receitaBruta,
    despesasProdutos,
    custosIndiretos,
    despesas,
    comissionamento,
    impostos,
    contribuicaoLiquida,
    mcl: receitaBruta === 0 ? 0 : contribuicaoLiquida / receitaBruta,
  };
}
