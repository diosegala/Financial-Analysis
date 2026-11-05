// Lê o Omie (SOMENTE LEITURA: só métodos Listar*) e grava no banco. Roda pelo botão do financeiro ou pelo agendamento
// semanal. Cada execução tem limite de tempo e de processamento, e é encerrada sem aviso ao passar dele. Por isso a
// leitura anda em partes curtas e encadeadas: as páginas ficam em omie_sync_cache, cada uma marca a posição, e
// omie_sync_watchdog retoma se uma execução morrer. A gravação de cada empresa é uma transação: se falhar, aquela
// empresa fica como estava. As chaves vêm do secret OMIE_CREDENTIALS, um JSON
// [{"app_key": "...", "app_secret": "..."}, ...], e nunca são impressas nem gravadas.
import { createClient } from "npm:@supabase/supabase-js@2.118.0";
import { aggregateExpenses, aggregateReceipts, type Json, yearsToRead } from "./aggregate.ts";

// Existe no ambiente das Edge Functions: mantém a execução viva depois da resposta.
declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void };

const BASE = Deno.env.get("OMIE_BASE_URL") ?? "https://app.omie.com.br/api/v1";
const SELF = `${Deno.env.get("SUPABASE_URL")}/functions/v1/omie-sync`;
const CRON_TOKEN = Deno.env.get("OMIE_SYNC_CRON_TOKEN") ?? "";
// Passado qualquer um dos dois, a execução guarda o que leu e segue numa nova chamada.
const TIME_BUDGET_MS = Number(Deno.env.get("OMIE_SYNC_TIME_BUDGET_MS") ?? 30_000);
const PAGE_BUDGET = Number(Deno.env.get("OMIE_SYNC_PAGE_BUDGET") ?? 8);

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });

interface Creds {
  app_key: string;
  app_secret: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function call(creds: Creds, endpoint: string, method: string, param: Json): Promise<Json> {
  if (!method.startsWith("Listar")) throw new Error("Somente leitura");
  const body = JSON.stringify({
    call: method,
    app_key: creds.app_key,
    app_secret: creds.app_secret,
    param: [param],
  });
  for (let attempt = 0; attempt < 6; attempt++) {
    const res = await fetch(`${BASE}/${endpoint}/`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
    if (res.ok) return await res.json();
    const text = (await res.text()).toLowerCase();
    // O Omie responde 500 quando a consulta não tem registros e quando a mesma consulta ainda está rodando.
    if (res.status === 500 && text.includes("não existem registros")) return {};
    if (res.status === 500 && text.includes("tentar novamente") && attempt < 5) {
      await sleep(10_000 * (attempt + 1));
      continue;
    }
    break;
  }
  throw new Error(`O Omie recusou ${method}. Confira a chave e a permissão da empresa.`);
}

type Admin = ReturnType<typeof createClient>;

/** O que já foi lido de um passo, guardado no banco entre as execuções. */
async function cached(admin: Admin, runId: string, step: string): Promise<Json[]> {
  const out: Json[] = [];
  for (let from = 0; ; from += 200) {
    const { data, error } = await admin
      .from("omie_sync_cache")
      .select("rows")
      .eq("run_id", runId)
      .eq("step", step)
      .order("page")
      .range(from, from + 199);
    if (error) throw new Error("Não foi possível ler o que já foi lido.");
    for (const r of data ?? []) out.push(...(r.rows as Json[]));
    if ((data ?? []).length < 200) return out;
  }
}

async function save(admin: Admin, runId: string, step: string, page: number, rows: Json[]) {
  const { error } = await admin.from("omie_sync_cache").upsert({ run_id: runId, step, page, rows });
  if (error) throw new Error("Não foi possível guardar o que foi lido.");
}

const pick = (o: Json, keys: string[]) => Object.fromEntries(keys.map((k) => [k, o?.[k]]));
const MOVEMENT_DETAILS = [
  "dDtPagamento",
  "cGrupo",
  "cOrigem",
  "nCodCliente",
  "nCodTitulo",
  "cCodCateg",
];
const TITLE_FIELDS = [
  "codigo_lancamento_omie",
  "codigo_cliente_fornecedor",
  "observacao",
  "status_titulo",
  "categorias",
  "distribuicao",
  "data_vencimento",
  "valor_documento",
  "codigo_categoria",
];

/** Títulos que entram na conta: os com movimento nos anos lidos e os em aberto nesses anos. */
const titleFilter = (movements: Json[], paidStatus: string, years: number[]) => {
  const moved = new Set(movements.map((m) => m.detalhes?.nCodTitulo));
  return (t: Json) =>
    moved.has(t.codigo_lancamento_omie) ||
    (t.status_titulo !== paidStatus &&
      t.status_titulo !== "CANCELADO" &&
      years.includes(Number(String(t.data_vencimento ?? "").slice(6))));
};

interface Page {
  rows: Json[];
  last: boolean;
}

/** Uma página de uma lista comum do Omie. */
async function listing(
  creds: Creds,
  endpoint: string,
  method: string,
  key: string,
  page: number,
  extra: Json = {},
): Promise<Page> {
  const r = await call(creds, endpoint, method, {
    pagina: page,
    registros_por_pagina: 100,
    ...extra,
  });
  return { rows: (r[key] as Json[]) ?? [], last: page >= Number(r.total_de_paginas ?? 1) };
}

async function movementPage(
  creds: Creds,
  years: number[],
  nature: "P" | "R",
  page: number,
): Promise<Page> {
  const r = await call(creds, "financas/mf", "ListarMovimentos", {
    nPagina: page,
    nRegPorPagina: 500,
    cNatureza: nature,
    dDtPagtoDe: `01/01/${Math.min(...years)}`,
    dDtPagtoAte: `31/12/${Math.max(...years)}`,
  });
  return {
    rows: ((r.movimentos as Json[]) ?? []).map((m) => ({
      detalhes: pick(m.detalhes, MOVEMENT_DETAILS),
      resumo: { nValPago: m.resumo?.nValPago },
    })),
    last: page >= Number(r.nTotPaginas ?? 1),
  };
}

/** Os passos de leitura de uma empresa, na ordem. Cada um devolve uma página por vez. */
function steps(admin: Admin, runId: string, creds: Creds, years: number[]) {
  const company = async (): Promise<Page> => {
    const r = await call(creds, "geral/empresas", "ListarEmpresas", {
      pagina: 1,
      registros_por_pagina: 5,
    });
    const cad = ((r.empresas_cadastro as Json[]) ?? [{}])[0] ?? {};
    // Mesmo nome que a carga anterior gravou: inicial maiúscula em cada palavra.
    const name = String(cad.nome_fantasia || cad.razao_social || "")
      .trim()
      .toLowerCase()
      .replace(/(^|[^\p{L}])(\p{L})/gu, (_, a, b) => a + b.toUpperCase());
    if (!name) throw new Error("O Omie não informou o nome da empresa.");
    return { rows: [{ name }], last: true };
  };
  return [
    { key: "company", read: company },
    {
      key: "departments",
      read: async (page: number) => {
        const r = await listing(
          creds,
          "geral/departamentos",
          "ListarDepartamentos",
          "departamentos",
          page,
        );
        return {
          ...r,
          rows: r.rows.map((d) => ({
            code: d.codigo,
            name: d.descricao,
            structure: d.estrutura ?? "",
          })),
        };
      },
    },
    {
      key: "categories",
      read: async (page: number) => {
        const r = await listing(
          creds,
          "geral/categorias",
          "ListarCategorias",
          "categoria_cadastro",
          page,
        );
        return {
          ...r,
          rows: r.rows.map((c) => ({
            code: c.codigo,
            name: c.descricao,
            parent_code:
              c.categoria_superior && c.categoria_superior !== "0" ? c.categoria_superior : null,
            is_expense: c.conta_despesa === "S",
            is_revenue: c.conta_receita === "S",
            is_total: c.totalizadora === "S",
          })),
        };
      },
    },
    { key: "paid", read: (page: number) => movementPage(creds, years, "P", page) },
    {
      key: "payables",
      read: async (page: number, ctx: Json) => {
        ctx.payable ??= titleFilter(await cached(admin, runId, "paid"), "PAGO", years);
        const r = await listing(
          creds,
          "financas/contapagar",
          "ListarContasPagar",
          "conta_pagar_cadastro",
          page,
          {
            apenas_importado_api: "N",
            exibir_obs: "S",
          },
        );
        return { ...r, rows: r.rows.filter(ctx.payable).map((t) => pick(t, TITLE_FIELDS)) };
      },
    },
    { key: "received", read: (page: number) => movementPage(creds, years, "R", page) },
    {
      key: "receivables",
      read: async (page: number, ctx: Json) => {
        ctx.receivable ??= titleFilter(await cached(admin, runId, "received"), "RECEBIDO", years);
        const r = await listing(
          creds,
          "financas/contareceber",
          "ListarContasReceber",
          "conta_receber_cadastro",
          page,
          { apenas_importado_api: "N" },
        );
        return { ...r, rows: r.rows.filter(ctx.receivable).map((t) => pick(t, TITLE_FIELDS)) };
      },
    },
    {
      key: "actuals",
      heavy: true,
      read: async (): Promise<Page> => ({
        rows: aggregateExpenses(
          await cached(admin, runId, "paid"),
          await cached(admin, runId, "payables"),
          years,
        ),
        last: true,
      }),
    },
    {
      key: "receipts",
      heavy: true,
      read: async (): Promise<Page> => ({
        rows: aggregateReceipts(
          await cached(admin, runId, "received"),
          await cached(admin, runId, "receivables"),
          years,
        ),
        last: true,
      }),
    },
    {
      key: "suppliers",
      read: async (page: number, ctx: Json) => {
        if (!ctx.used) {
          const actuals = await cached(admin, runId, "actuals");
          const receipts = await cached(admin, runId, "receipts");
          ctx.used = new Set([
            ...actuals.map((r) => r.supplier_code),
            ...receipts.map((r) => r.client_code),
          ]);
        }
        const r = await listing(
          creds,
          "geral/clientes",
          "ListarClientes",
          "clientes_cadastro",
          page,
          {
            apenas_importado_api: "N",
          },
        );
        return {
          ...r,
          rows: r.rows
            .filter((c) => ctx.used.has(String(c.codigo_cliente_omie ?? "")))
            .map((c) => ({
              code: String(c.codigo_cliente_omie),
              name: String(c.nome_fantasia || c.razao_social || c.codigo_cliente_omie).trim(),
            })),
        };
      },
    },
  ];
}

/** Chama a própria função para seguir de onde parou. Se a chamada falhar, o vigia retoma pela posição marcada. */
async function chain(body: Json) {
  try {
    const res = await fetch(SELF, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-omie-sync-token": CRON_TOKEN },
      body: JSON.stringify(body),
    });
    await res.body?.cancel();
    if (!res.ok) console.error(`omie-sync: a próxima parte respondeu ${res.status}`);
  } catch {
    console.error("omie-sync: não foi possível chamar a próxima parte");
  }
}

/** Segue a leitura: lê páginas até o limite da execução, grava a empresa e passa para a próxima; na última, fecha a leitura. */
async function run(runId: string, index: number, step: number, page: number) {
  const startedAt = Date.now();
  const admin = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );
  const all = JSON.parse(Deno.env.get("OMIE_CREDENTIALS") ?? "[]") as Creds[];
  const years = yearsToRead(new Date());
  const mark = async (s: number, p: number) => {
    const { error } = await admin.rpc("omie_sync_checkpoint", {
      _run_id: runId,
      _index: index,
      _step: s,
      _page: p,
    });
    if (error) throw new Error("Não foi possível marcar a posição da leitura.");
  };
  let error: string | null = null;
  // Depois da última empresa, só falta fechar. Uma retomada pode chegar até aqui.
  if (all.length > 0 && index >= all.length) {
    await admin.rpc("omie_sync_finish", { _run_id: runId });
    return;
  }
  try {
    if (all.length === 0) throw new Error("As chaves do Omie não estão cadastradas.");
    // Começo de empresa: o que sobrou da anterior não pode entrar na conta desta.
    if (step === 0 && page === 1) await admin.from("omie_sync_cache").delete().eq("run_id", runId);
    const list = steps(admin, runId, all[index]!, years);
    const ctx: Json = {};
    let done = 0;
    const spent = () => done >= PAGE_BUDGET || Date.now() - startedAt > TIME_BUDGET_MS;
    for (; step < list.length; step++, page = 1) {
      const current = list[step]!;
      // As contas pesadas rodam sozinhas numa execução.
      if (current.heavy && done > 0) return await chain({ run_id: runId, index, step, page: 1 });
      for (; ; page++) {
        const r = await current.read(page, ctx);
        await save(admin, runId, current.key, page, r.rows);
        await (r.last ? mark(step + 1, 1) : mark(step, page + 1));
        done++;
        if (r.last) break;
        if (spent()) return await chain({ run_id: runId, index, step, page: page + 1 });
      }
      if (current.heavy || spent())
        return await chain({ run_id: runId, index, step: step + 1, page: 1 });
    }
    // A gravação também roda sozinha.
    if (done > 0) return await chain({ run_id: runId, index, step, page: 1 });
    const stored = await admin.rpc("omie_store_company", {
      _name: (await cached(admin, runId, "company"))[0]?.name,
      _years: years,
      _departments: await cached(admin, runId, "departments"),
      _categories: await cached(admin, runId, "categories"),
      _suppliers: await cached(admin, runId, "suppliers"),
      _actuals: await cached(admin, runId, "actuals"),
      _receipts: await cached(admin, runId, "receipts"),
    });
    if (stored.error) throw new Error("Não foi possível gravar os dados no banco.");
  } catch (e) {
    error = e instanceof Error ? e.message : "Erro inesperado.";
    console.error(`omie-sync: empresa ${index + 1}: ${error}`);
  }
  const named = await cached(admin, runId, "company").catch(() => []);
  await admin.rpc("omie_sync_progress", {
    _run_id: runId,
    _company: named[0]?.name ?? `Empresa ${index + 1}`,
    _error: error,
  });
  await admin.from("omie_sync_cache").delete().eq("run_id", runId);
  if (index + 1 < all.length)
    return await chain({ run_id: runId, index: index + 1, step: 0, page: 1 });
  await admin.rpc("omie_sync_finish", { _run_id: runId });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const body = await req.json().catch(() => ({}));
  const admin = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );
  const internal = CRON_TOKEN !== "" && req.headers.get("x-omie-sync-token") === CRON_TOKEN;
  let userId: string | null = null;
  if (!internal) {
    const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
    const { data } = await admin.auth.getUser(token);
    userId = data.user?.id ?? null;
    if (!userId) return json({ error: "Faça login para ler o Omie." }, 401);
    const role = await admin.rpc("has_role", { _user_id: userId, _role: "financeiro" });
    if (role.data !== true) return json({ error: "Só o financeiro lê o Omie." }, 403);
  }
  // Próxima parte de uma leitura em andamento.
  if (internal && body.run_id) {
    EdgeRuntime.waitUntil(
      run(String(body.run_id), Number(body.index), Number(body.step), Number(body.page)),
    );
    return json({ run_id: body.run_id });
  }
  const start = await admin.rpc("omie_sync_start", { _by: userId });
  if (start.error) return json({ error: start.error.message }, 409);
  EdgeRuntime.waitUntil(run(String(start.data), 0, 0, 1));
  return json({ run_id: start.data });
});
