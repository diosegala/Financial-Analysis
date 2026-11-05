// Regras da leitura do Omie, as mesmas de scripts/omie-sync.py. "Pago"/"recebido" é o movimento efetivo, pela data em
// que aconteceu; "em aberto" são os títulos a vencer ou atrasados, pelo vencimento. Cancelados, baixas repetidas e
// transferências entre contas ficam de fora. Sem acesso à rede nem ao banco: só contas.

// O Omie devolve JSON sem tipo.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Json = any;

export interface ExpenseRow {
  year: number;
  month: number;
  category_code: string;
  department_code: string;
  supplier_code: string;
  item: string;
  amount_paid: number;
  amount_open: number;
}

export interface ReceiptRow {
  year: number;
  month: number;
  category_code: string;
  department_code: string;
  client_code: string;
  amount_received: number;
  amount_open: number;
}

const NO_DEPARTMENT = [{ cCodDep: "", nPerDep: 100 }];
const num = (v: unknown) => Number(v ?? 0) || 0;
const str = (v: unknown) => (v === null || v === undefined || v === 0 ? "" : String(v));
const round2 = (v: number) => Math.round((v + Number.EPSILON) * 100) / 100;

/** Nome do item a partir da observação do título ("Figma||14/03 FIGMA USD60" → "Figma"). Texto automático não é item. */
export function itemOf(obs: unknown): string {
  let text = String(obs ?? "")
    .split("\n")[0]!
    .split("|")[0]!
    .trim();
  text = text.replace(/\s*[-–]\s*[A-Za-z0-9-]*\d[A-Za-z0-9-]*\s*$/, "").trim();
  const low = text.toLowerCase();
  if (
    !text ||
    low.startsWith("conta a pagar") ||
    low.startsWith("importad") ||
    low.startsWith("gerad")
  )
    return "";
  return text.slice(0, 80);
}

/** Reparte um valor pelas categorias do título (na proporção de cada uma) e pelos departamentos. */
export function split(cats: Json[], deps: Json[], value: number): [string, string, number][] {
  const base = cats.reduce((a, c) => a + num(c.valor), 0) || 1;
  const out: [string, string, number][] = [];
  for (const c of cats) {
    const part = cats.length > 1 ? (value * num(c.valor)) / base : value;
    for (const dep of deps) {
      const pct = dep.nPerDep === undefined || dep.nPerDep === null ? 100 : num(dep.nPerDep);
      out.push([
        c.codigo_categoria || c.cCodCateg || "?",
        String(dep.cCodDep || ""),
        (part * pct) / 100,
      ]);
    }
  }
  return out;
}

/** "dd/mm/aaaa" de um dos anos lidos → [ano, mês]; fora disso, null. */
function yearMonth(date: unknown, years: number[]): [number, number] | null {
  const d = String(date ?? "");
  if (d.length !== 10) return null;
  const year = Number(d.slice(6));
  return years.includes(year) ? [year, Number(d.slice(3, 5))] : null;
}

const list = (v: unknown, fallback: Json[]): Json[] =>
  Array.isArray(v) && v.length > 0 ? (v as Json[]) : fallback;

export function aggregateExpenses(
  movements: Json[],
  payables: Json[],
  years: number[],
): ExpenseRow[] {
  const titles = new Map(payables.map((t) => [t.codigo_lancamento_omie, t]));
  const agg = new Map<string, ExpenseRow>();
  const add = (
    y: number,
    m: number,
    cat: string,
    dep: string,
    sup: string,
    item: string,
    paid: number,
    open: number,
  ) => {
    const key = JSON.stringify([y, m, cat, dep, sup, item]);
    const row =
      agg.get(key) ??
      ({
        year: y,
        month: m,
        category_code: cat,
        department_code: dep,
        supplier_code: sup,
        item,
        amount_paid: 0,
        amount_open: 0,
      } as ExpenseRow);
    row.amount_paid += paid;
    row.amount_open += open;
    agg.set(key, row);
  };
  for (const mov of movements) {
    const d = mov.detalhes ?? {};
    const value = num(mov.resumo?.nValPago);
    const ym = yearMonth(d.dDtPagamento, years);
    if (!ym || !value) continue;
    let supplier = str(d.nCodCliente);
    let item = "";
    let cats: Json[];
    let deps = NO_DEPARTMENT as Json[];
    if (d.cGrupo === "CONTA_A_PAGAR") {
      const t = titles.get(d.nCodTitulo) ?? {};
      supplier = str(t.codigo_cliente_fornecedor) || supplier;
      item = itemOf(t.observacao);
      cats = list(t.categorias, [{ cCodCateg: d.cCodCateg, valor: value }]);
      deps = list(t.distribuicao, NO_DEPARTMENT);
    } else if (d.cGrupo === "CONTA_CORRENTE_PAG" && d.cOrigem !== "BAXP" && d.cOrigem !== "TRAP") {
      cats = [{ cCodCateg: d.cCodCateg, valor: value }];
    } else continue;
    for (const [cat, dep, part] of split(cats, deps, value))
      add(ym[0], ym[1], cat, dep, supplier, item, part, 0);
  }
  for (const t of payables) {
    if (t.status_titulo === "PAGO" || t.status_titulo === "CANCELADO") continue;
    const ym = yearMonth(t.data_vencimento, years);
    if (!ym) continue;
    const doc = num(t.valor_documento);
    const cats = list(t.categorias, [{ codigo_categoria: t.codigo_categoria, valor: doc }]);
    for (const [cat, dep, part] of split(cats, list(t.distribuicao, NO_DEPARTMENT), doc))
      add(ym[0], ym[1], cat, dep, str(t.codigo_cliente_fornecedor), itemOf(t.observacao), 0, part);
  }
  return [...agg.values()].map((r) => ({
    ...r,
    amount_paid: round2(r.amount_paid),
    amount_open: round2(r.amount_open),
  }));
}

export function aggregateReceipts(
  movements: Json[],
  receivables: Json[],
  years: number[],
): ReceiptRow[] {
  const titles = new Map(receivables.map((t) => [t.codigo_lancamento_omie, t]));
  const agg = new Map<string, ReceiptRow>();
  const add = (
    y: number,
    m: number,
    cat: string,
    dep: string,
    client: string,
    got: number,
    open: number,
  ) => {
    const key = JSON.stringify([y, m, cat, dep, client]);
    const row =
      agg.get(key) ??
      ({
        year: y,
        month: m,
        category_code: cat,
        department_code: dep,
        client_code: client,
        amount_received: 0,
        amount_open: 0,
      } as ReceiptRow);
    row.amount_received += got;
    row.amount_open += open;
    agg.set(key, row);
  };
  for (const mov of movements) {
    const d = mov.detalhes ?? {};
    const value = num(mov.resumo?.nValPago);
    const ym = yearMonth(d.dDtPagamento, years);
    if (!ym || !value) continue;
    let client = str(d.nCodCliente);
    let cats: Json[];
    let deps = NO_DEPARTMENT as Json[];
    if (d.cGrupo === "CONTA_A_RECEBER") {
      const t = titles.get(d.nCodTitulo) ?? {};
      client = str(t.codigo_cliente_fornecedor) || client;
      cats = list(t.categorias, [{ cCodCateg: d.cCodCateg, valor: value }]);
      deps = list(t.distribuicao, NO_DEPARTMENT);
    } else if (d.cGrupo === "CONTA_CORRENTE_REC" && d.cOrigem !== "BAXR" && d.cOrigem !== "TRAR") {
      cats = [{ cCodCateg: d.cCodCateg, valor: value }];
    } else continue;
    for (const [cat, dep, part] of split(cats, deps, value))
      add(ym[0], ym[1], cat, dep, client, part, 0);
  }
  for (const t of receivables) {
    if (t.status_titulo === "RECEBIDO" || t.status_titulo === "CANCELADO") continue;
    const ym = yearMonth(t.data_vencimento, years);
    if (!ym) continue;
    const doc = num(t.valor_documento);
    const cats = list(t.categorias, [{ codigo_categoria: t.codigo_categoria, valor: doc }]);
    for (const [cat, dep, part] of split(cats, list(t.distribuicao, NO_DEPARTMENT), doc))
      add(ym[0], ym[1], cat, dep, str(t.codigo_cliente_fornecedor), 0, part);
  }
  return [...agg.values()].map((r) => ({
    ...r,
    amount_received: round2(r.amount_received),
    amount_open: round2(r.amount_open),
  }));
}

/** Anos da leitura: o atual e o seguinte; até março, também o anterior, para fechar o ano que passou. */
export function yearsToRead(now: Date): number[] {
  const year = now.getUTCFullYear();
  return now.getUTCMonth() < 3 ? [year - 1, year, year + 1] : [year, year + 1];
}
