// Alertas com IA: roda os detectores (alerts_refresh) com o usuário que chamou e pede ao Claude um resumo curto por
// unidade: o que mudou, a causa provável e o que verificar. Grava em alert_summaries.
// Sem o secret ANTHROPIC_API_KEY, só atualiza os alertas.
import Anthropic from "npm:@anthropic-ai/sdk@1.3.0";
import { createClient } from "npm:@supabase/supabase-js@2.118.0";

const MODEL = "claude-opus-5-5";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });

const SYSTEM = `Você é analista financeiro da CUPOLA, empresa com unidades de consultoria, agência (receita recorrente
de contratos e projetos variáveis) e educação (treinamentos online e presenciais, imersões, eventos e comunidade).
Recebe alertas gerados por regras sobre o realizado do ERP e sobre o plano do ano seguinte, e escreve para a
diretoria e para o líder de cada unidade.

Para cada unidade com alertas, escreva de 2 a 4 frases curtas: o que mudou, a causa provável e o que o líder deve
verificar. Use só os números que vêm nos alertas; não invente valores, clientes nem causas como fato. Quando a causa
for hipótese, diga que é provável ou possível. Se vários alertas apontam para o mesmo fato (ex.: queda de receita e
cliente que parou de pagar), junte em uma explicação. Escreva em português do Brasil, direto, sem jargão.
No resumo da empresa, em até 4 frases, diga o que a diretoria deve olhar primeiro.`;

const SCHEMA = {
  type: "object",
  properties: {
    empresa: { type: "string" },
    unidades: {
      type: "array",
      items: {
        type: "object",
        properties: { unit_id: { type: "string" }, resumo: { type: "string" } },
        required: ["unit_id", "resumo"],
        additionalProperties: false,
      },
    },
  },
  required: ["empresa", "unidades"],
  additionalProperties: false,
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const { version_id = null, scenario_id = null } = await req.json().catch(() => ({}));
  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
  });

  const refresh = await supabase.rpc("alerts_refresh", {
    _version_id: version_id,
    _scenario_id: scenario_id,
  });
  if (refresh.error) return json({ error: refresh.error.message }, 403);

  // Mesmo mês de referência do SQL: o último mês fechado.
  const now = new Date();
  const ref = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1))
    .toISOString()
    .slice(0, 10);
  let query = supabase
    .from("alerts")
    .select("unit_id, kind, severity, title, detail, value, change")
    .eq("status", "novo");
  query = version_id
    ? query.or(`period.eq.${ref},version_id.eq.${version_id}`)
    : query.eq("period", ref);
  const [alerts, units] = await Promise.all([
    query,
    supabase.from("units").select("id, name, kind"),
  ]);
  if (alerts.error || units.error)
    return json({ error: (alerts.error ?? units.error)!.message }, 500);

  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!apiKey || alerts.data.length === 0) {
    return json({
      alerts: refresh.data,
      summary: false,
      reason: apiKey ? "sem alertas" : "sem chave",
    });
  }

  const unitName = new Map(units.data.map((u) => [u.id, u.name]));
  const byUnit = new Map<string, unknown[]>();
  for (const a of alerts.data) {
    const key = a.unit_id ?? "";
    byUnit.set(key, [...(byUnit.get(key) ?? []), { ...a, unit_id: undefined }]);
  }
  const input = [...byUnit.entries()].map(([id, list]) => ({
    unit_id: id,
    unidade: id ? (unitName.get(id) ?? "?") : "Sem unidade",
    alertas: list,
  }));

  const client = new Anthropic({ apiKey });
  let response;
  try {
    response = await client.beta.messages.create({
      model: MODEL,
      max_tokens: 16000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort: "medium", format: { type: "json_schema", schema: SCHEMA } },
      system: SYSTEM,
      messages: [
        {
          role: "user",
          content: `Mês de referência do realizado: ${ref.slice(0, 7)}. Alertas por unidade (unit_id vazio = sem unidade):\n${JSON.stringify(input, null, 1)}`,
        },
      ],
    });
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
    return json({ error: `O resumo não foi gerado (${response.stop_reason}).` }, 502);
  }
  const text = response.content.find((b) => b.type === "text");
  if (!text || text.type !== "text") return json({ error: "Resposta sem texto." }, 502);
  const parsed = JSON.parse(text.text) as {
    empresa: string;
    unidades: { unit_id: string; resumo: string }[];
  };

  const { data: user } = await supabase.auth.getUser();
  const rows = [
    { period: ref, unit_id: null, text: parsed.empresa },
    ...parsed.unidades
      // Alertas sem unidade entram só no resumo da empresa (o financeiro vê cada um na lista).
      .filter((u) => unitName.has(u.unit_id))
      .map((u) => ({ period: ref, unit_id: u.unit_id, text: u.resumo })),
  ].map((r) => ({ ...r, model: response.model, created_by: user.user?.id ?? null }));
  const del = await supabase.from("alert_summaries").delete().eq("period", ref);
  if (del.error) return json({ error: del.error.message }, 500);
  const ins = await supabase.from("alert_summaries").insert(rows);
  if (ins.error) return json({ error: ins.error.message }, 500);
  return json({ alerts: refresh.data, summary: true, units: rows.length - 1 });
});
