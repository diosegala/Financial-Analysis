// Lê a planilha de produtos de Educação (Google Sheets, SOMENTE LEITURA) e grava cada aba ligada a um produto.
// Roda pelo botão do financeiro ou pela leitura diária. Com a versão aberta, troca os lançamentos que vieram da planilha;
// com a versão travada, grava só a previsão. A chave da conta de serviço do Google fica no secret GOOGLE_SERVICE_ACCOUNT
// (o JSON baixado do Google Cloud) e nunca é impressa nem gravada.
import { createClient } from "npm:@supabase/supabase-js@2.118.0";
import { parseTab, type Cell } from "./parse.ts";

const SHEETS = Deno.env.get("SHEETS_BASE_URL") ?? "https://sheets.googleapis.com/v4";
const CRON_TOKEN = Deno.env.get("OMIE_SYNC_CRON_TOKEN") ?? "";
const RANGE = "A1:AF800";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });

interface ServiceAccount {
  client_email: string;
  private_key: string;
  token_uri?: string;
}

const b64url = (data: Uint8Array | string) =>
  btoa(typeof data === "string" ? data : String.fromCharCode(...data))
    .replace(/=+$/, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");

/** Token de acesso da conta de serviço, só com leitura de planilhas. */
async function accessToken(sa: ServiceAccount): Promise<string> {
  const tokenUri = sa.token_uri ?? "https://oauth2.googleapis.com/token";
  const now = Math.floor(Date.now() / 1000);
  const unsigned = `${b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${b64url(
    JSON.stringify({
      iss: sa.client_email,
      scope: "https://www.googleapis.com/auth/spreadsheets.readonly",
      aud: tokenUri,
      iat: now,
      exp: now + 3600,
    }),
  )}`;
  const pem = sa.private_key.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
  const der = Uint8Array.from(atob(pem), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey(
    "pkcs8",
    der,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = new Uint8Array(
    await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(unsigned)),
  );
  const res = await fetch(tokenUri, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: `${unsigned}.${b64url(sig)}`,
    }),
  });
  if (!res.ok) throw new Error("O Google recusou a conta de serviço. Confira a chave cadastrada.");
  return (await res.json()).access_token;
}

async function google(token: string, path: string) {
  const res = await fetch(`${SHEETS}${path}`, { headers: { Authorization: `Bearer ${token}` } });
  if (res.status === 403 || res.status === 404)
    throw new Error(
      "A planilha não foi encontrada. Compartilhe-a com a conta de serviço como leitora.",
    );
  if (!res.ok) throw new Error(`O Google respondeu ${res.status} ao ler a planilha.`);
  return await res.json();
}

const quote = (title: string) => `'${title.replace(/'/g, "''")}'`;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
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
    if (!userId) return json({ error: "Faça login para ler a planilha." }, 401);
    const role = await admin.rpc("has_role", { _user_id: userId, _role: "financeiro" });
    if (role.data !== true) return json({ error: "Só o financeiro lê a planilha." }, 403);
  }

  const { data: settings } = await admin
    .from("edu_sheet_settings")
    .select("spreadsheet_id, version_id, budget_versions(year, status)")
    .order("created_at")
    .limit(1)
    .maybeSingle();
  const version = settings?.budget_versions as { year: number; status: string } | null;
  if (!settings?.spreadsheet_id || !version)
    return json({ error: "Informe o link da planilha e a versão em Configurações." }, 400);

  const start = await admin.rpc("edu_sheet_start", { _by: userId });
  if (start.error) return json({ error: start.error.message }, 409);
  const runId = String(start.data);
  const read: string[] = [];
  const errors: string[] = [];
  try {
    const sa = JSON.parse(
      Deno.env.get("GOOGLE_SERVICE_ACCOUNT") ?? "null",
    ) as ServiceAccount | null;
    if (!sa?.client_email || !sa.private_key)
      throw new Error("A chave da conta de serviço do Google não está cadastrada.");
    const token = await accessToken(sa);
    // Aceita o link inteiro da planilha ou só o id.
    const raw = String(settings.spreadsheet_id).trim();
    const id = encodeURIComponent(/\/d\/([\w-]+)/.exec(raw)?.[1] ?? raw);
    const meta = await google(token, `/spreadsheets/${id}?fields=sheets.properties.title`);
    const titles: string[] = (meta.sheets ?? []).map(
      (s: { properties: { title: string } }) => s.properties.title,
    );
    const ranges = titles
      .map((t) => `ranges=${encodeURIComponent(`${quote(t)}!${RANGE}`)}`)
      .join("&");
    const batch = (render: string) =>
      google(token, `/spreadsheets/${id}/values:batchGet?${ranges}&valueRenderOption=${render}`);
    const [values, formulas] = await Promise.all([batch("UNFORMATTED_VALUE"), batch("FORMULA")]);
    const { data: tabs } = await admin.from("edu_sheet_tabs").select("tab_name, active");
    const active = new Set((tabs ?? []).filter((t) => t.active).map((t) => t.tab_name));

    for (const [i, title] of titles.entries()) {
      const parsed = parseTab(
        {
          title,
          values: (values.valueRanges?.[i]?.values ?? []) as Cell[][],
          formulas: (formulas.valueRanges?.[i]?.values ?? []) as Cell[][],
        },
        version.year,
      );
      const stored = await admin.rpc("edu_sheet_store", {
        _run_id: runId,
        _tab: title,
        _title: parsed.title || null,
        _blocks: parsed.blocks.map((b) => ({ kind: b.kind, label: b.label, months: b.months })),
        _warnings: parsed.warnings,
        _error: parsed.error ?? null,
      });
      const name = title.trim();
      if (stored.error) errors.push(`${name}: ${stored.error.message}`);
      else if (stored.data === "plano" || stored.data === "previsao") read.push(name);
      else if (stored.data === "erro" && active.has(name))
        errors.push(`${name}: ${parsed.error ?? "o produto não tem conta de receita e de custo."}`);
    }
  } catch (e) {
    errors.push(e instanceof Error ? e.message : "Erro inesperado.");
  }
  await admin.rpc("edu_sheet_finish", {
    _run_id: runId,
    _tabs: read,
    _errors: errors,
    _target: version.status === "travado" ? "previsao" : "plano",
  });
  return json({ run_id: runId, tabs: read, errors });
});
