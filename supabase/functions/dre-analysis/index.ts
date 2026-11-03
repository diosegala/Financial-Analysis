// Análise da DRE com IA: lê os mesmos números das telas, com o usuário que chamou (só o que ele pode ver), pede ao Claude
// onde ajustar, onde há gargalo e como o ano deve fechar, e grava a análise da unidade ou da empresa em dre_analyses.
import Anthropic from "npm:@anthropic-ai/sdk@1.3.0";
import { createClient } from "npm:@supabase/supabase-js@2.118.0";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });

const SYSTEM = `Você é analista financeiro da CUPOLA e escreve para o diretor da unidade, para o financeiro e para o CEO.
A empresa tem unidades de negócio (que geram receita) e áreas de apoio. Cada unidade tem receita-compromisso e limite de
custos para o ano. O plano aprovado não muda: pagamentos que trocam de mês viram remanejamentos.

Você recebe a DRE (previsto, realizado dos meses fechados e previsão do ano), as categorias com o ano base, o previsto e o
realizado, o limite e os remanejamentos. Sem meses fechados, analise o plano contra o ano base.

Regras:
- Use só os números recebidos. Não invente valores, clientes, fornecedores nem causas como fato. Hipótese é hipótese: diga
  "provável" ou "possível".
- "gargalos": o que ameaça o resultado (categoria que cresce, custo acima do limite, receita abaixo do compromisso,
  concentração de gasto, descasamento entre meses).
- "ajustes": onde a DRE pode ser ajustada, em ordem de impacto, com o valor quando der para calcular.
- "previsao": como o ano tende a fechar e o que muda esse fechamento.
- Diferença de calendário coberta por remanejamento não é economia nem estouro.
- Seja direto, em português do Brasil e sem jargão. No máximo 5 gargalos e 5 ajustes.`;

const SCHEMA = {
  type: "object",
  properties: {
    resumo: { type: "string" },
    gargalos: {
      type: "array",
      items: {
        type: "object",
        properties: { titulo: { type: "string" }, explicacao: { type: "string" } },
        required: ["titulo", "explicacao"],
        additionalProperties: false,
      },
    },
    ajustes: {
      type: "array",
      items: {
        type: "object",
        properties: { titulo: { type: "string" }, explicacao: { type: "string" } },
        required: ["titulo", "explicacao"],
        additionalProperties: false,
      },
    },
    previsao: { type: "string" },
  },
  required: ["resumo", "gargalos", "ajustes", "previsao"],
  additionalProperties: false,
};

const round = (v: unknown) => Math.round(Number(v ?? 0));

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const {
    version_id,
    scenario_id,
    unit_id = null,
    test = false,
  } = await req.json().catch(() => ({}));
  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
  });
  const { data: caller } = await supabase.auth.getUser();
  if (!caller.user) return json({ error: "Entre no app para usar a análise." }, 401);

  // A chave e o modelo vêm da configuração feita na tela; só aqui, no servidor, a chave é lida.
  const admin = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );
  const { data: config, error: configError } = await admin.rpc("ai_runtime_config").maybeSingle();
  if (configError) return json({ error: "Não foi possível ler a configuração da IA." }, 500);
  const apiKey = config?.api_key;
  const model = config?.model ?? "claude-opus-5-5";
  if (!apiKey) return json({ error: "A chave da IA ainda não foi cadastrada." }, 503);

  // Testar a chave: só o financeiro, em Configurações.
  if (test) {
    const { data: settings } = await supabase.from("ai_settings").select("id").maybeSingle();
    if (!settings) return json({ error: "Somente o financeiro testa a chave." }, 403);
    try {
      await new Anthropic({ apiKey }).messages.create({
        model,
        max_tokens: 16,
        messages: [{ role: "user", content: "Responda apenas: ok" }],
      });
      return json({ ok: true });
    } catch (e) {
      if (e instanceof Anthropic.AuthenticationError)
        return json({ error: "Chave da API do Claude inválida." }, 502);
      if (e instanceof Anthropic.APIError)
        return json({ error: `API do Claude: ${e.status} ${e.message}` }, 502);
      throw e;
    }
  }

  if (!config?.enabled) return json({ error: "A análise por IA está desligada." }, 503);
  if (!version_id || !scenario_id)
    return json({ error: "Versão e cenário são obrigatórios." }, 400);
  const scope = unit_id ? { _unit_ids: [unit_id] } : {};
  const base = { _version_id: version_id, _scenario_id: scenario_id, ...scope };
  const [compare, accounts, lines, guardrails, version, units, shifts, settings] =
    await Promise.all([
      supabase.rpc("dre_compare", base),
      supabase.rpc("account_compare", base),
      supabase.from("dre_lines").select("id, name, kind, sort_order").eq("active", true),
      supabase.rpc("guardrails", { _scenario_id: scenario_id }),
      supabase.from("budget_versions").select("year, closed_month").eq("id", version_id).single(),
      supabase.from("units").select("id, name, kind"),
      (() => {
        const q = supabase
          .from("plan_shifts")
          .select("from_month, to_month, amount, note, accounts(name), units(name)")
          .eq("version_id", version_id);
        return unit_id ? q.eq("unit_id", unit_id) : q;
      })(),
      supabase
        .from("guardrail_settings")
        .select("result_target, cost_cut_pct")
        .eq("scenario_id", scenario_id)
        .maybeSingle(),
    ]);
  const failed = [compare, accounts, lines, guardrails, version, units, shifts].find(
    (r) => r.error,
  );
  if (failed?.error) return json({ error: failed.error.message }, 403);
  if ((compare.data ?? []).length === 0) return json({ error: "Você não vê esta unidade." }, 403);

  const names = new Map(units.data!.map((u) => [u.id, u]));
  const dre = [...lines.data!]
    .sort((a, b) => a.sort_order - b.sort_order)
    .filter((l) => l.kind !== "percentual")
    .map((l) => {
      const rows = compare.data!.filter((r) => r.dre_line_id === l.id);
      const year = rows.find((r) => r.month === 0);
      const months = rows.filter((r) => r.month > 0).sort((a, b) => a.month - b.month);
      return {
        linha: l.name,
        previsto_ano: round(year?.planned),
        realizado_meses_fechados: round(year?.actual),
        previsao_ano: round(year?.forecast),
        previsto_por_mes: months.map((r) => round(r.planned)),
        realizado_por_mes: months.map((r) => round(r.actual)),
      };
    });
  const byAccount = new Map<
    string,
    { categoria: string; tipo: string; ano_base: number; previsto: number; realizado: number }
  >();
  for (const r of accounts.data ?? []) {
    const a = byAccount.get(r.account_id) ?? {
      categoria: r.name,
      tipo: r.kind,
      ano_base: 0,
      previsto: 0,
      realizado: 0,
    };
    a.ano_base += Number(r.base);
    a.previsto += Number(r.planned);
    a.realizado += Number(r.actual);
    byAccount.set(r.account_id, a);
  }
  const categorias = [...byAccount.values()]
    .map((a) => ({
      ...a,
      ano_base: round(a.ano_base),
      previsto: round(a.previsto),
      realizado: round(a.realizado),
    }))
    .sort(
      (a, b) =>
        Math.max(b.ano_base, b.previsto, b.realizado) -
        Math.max(a.ano_base, a.previsto, a.realizado),
    )
    .slice(0, 60);
  const unidades = (guardrails.data ?? [])
    .filter((g) => !unit_id || g.unit_id === unit_id)
    .map((g) => ({
      unidade: names.get(g.unit_id)?.name,
      tipo: g.kind,
      receita_compromisso: round(g.floor_amount),
      receita_lancada: round(g.planned_revenue),
      custo_base: round(Number(g.base_expense) + Number(g.base_payroll)),
      limite_de_custos: round(g.ceiling),
      despesas_lancadas: round(g.planned_expense),
      folha_lancada: round(g.planned_payroll),
    }));
  const input = {
    escopo: unit_id ? names.get(unit_id)?.name : "CUPOLA (empresa inteira)",
    ano: version.data!.year,
    ultimo_mes_fechado: version.data!.closed_month,
    resultado_alvo_da_empresa: unit_id ? undefined : round(settings.data?.result_target),
    corte_de_custos: Number(settings.data?.cost_cut_pct ?? 0),
    unidades,
    dre,
    categorias,
    remanejamentos: (shifts.data ?? []).map((s) => ({
      de_mes: s.from_month,
      para_mes: s.to_month,
      valor: round(s.amount),
      motivo: s.note,
    })),
  };

  const client = new Anthropic({ apiKey });
  let response;
  try {
    response = await client.beta.messages
      .stream({
        model,
        max_tokens: 16000,
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        thinking: { type: "adaptive" },
        output_config: { effort: "medium", format: { type: "json_schema", schema: SCHEMA } },
        system: SYSTEM,
        messages: [{ role: "user", content: `Dados do planejamento:\n${JSON.stringify(input)}` }],
      })
      .finalMessage();
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError)
      return json({ error: "Chave da API do Claude inválida." }, 502);
    if (e instanceof Anthropic.RateLimitError)
      return json({ error: "Limite da API do Claude; tente em instantes." }, 503);
    if (e instanceof Anthropic.APIError)
      return json({ error: `API do Claude: ${e.status} ${e.message}` }, 502);
    throw e;
  }
  if (response.stop_reason === "refusal" || response.stop_reason === "max_tokens") {
    return json({ error: `A análise não foi gerada (${response.stop_reason}).` }, 502);
  }
  const text = response.content.find((b) => b.type === "text");
  if (!text || text.type !== "text") return json({ error: "Resposta sem texto." }, 502);
  const content = JSON.parse(text.text);

  const del = supabase.from("dre_analyses").delete().eq("version_id", version_id);
  const removed = await (unit_id ? del.eq("unit_id", unit_id) : del.is("unit_id", null));
  if (removed.error) return json({ error: removed.error.message }, 500);
  const ins = await supabase.from("dre_analyses").insert({
    version_id,
    unit_id,
    content,
    model: response.model,
    created_by: caller.user.id,
  });
  if (ins.error) return json({ error: ins.error.message }, 500);
  return json({ ok: true });
});
