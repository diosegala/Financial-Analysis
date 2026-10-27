#!/usr/bin/env python3
"""Lê o realizado do Omie (SOMENTE LEITURA) e grava no banco do planejamento.

  python3 scripts/omie-sync.py --dry-run                 # só mostra o resumo, não grava
  python3 scripts/omie-sync.py                           # projeto real (precisa de `supabase login` e `supabase link`)
  python3 scripts/omie-sync.py --target local            # banco local, para testes
  python3 scripts/omie-sync.py --year 2025 --year 2026   # mais de um ano

Uma empresa por arquivo, na pasta --env-dir (padrão ~/Documents/testes_financeiro): omie_central.env, omie_pw.env,
omie_mktimob.env… Cada arquivo tem OMIE_APP_KEY e OMIE_APP_SECRET. As chaves nunca são impressas nem gravadas no
banco, e só métodos Listar* são chamados: o Omie não recebe nenhuma escrita.

Grava, por empresa: departamentos, categorias, as despesas por mês, categoria e departamento, e as receitas por mês,
categoria, departamento e cliente. "Pago"/"recebido" é o movimento efetivo, pela data em que aconteceu (títulos de
contas a pagar ou a receber e lançamentos feitos direto no extrato); "em aberto" são os títulos a vencer ou atrasados,
pelo vencimento. Cancelados, baixas repetidas e transferências entre contas ficam de fora. Rodar de novo troca o que
existe daqueles anos para a empresa.
"""
import argparse
import collections
import glob
import json
import os
import re
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request

BASE = "https://app.omie.com.br/api/v1"


def read_env(path):
    d = {}
    for line in open(path, encoding="utf-8"):
        if "=" in line and not line.lstrip().startswith("#"):
            k, v = line.strip().split("=", 1)
            d[k.strip()] = v.strip().strip('"').strip("'")
    return d["OMIE_APP_KEY"], d["OMIE_APP_SECRET"]


def call(creds, endpoint, method, param):
    assert method.startswith("Listar"), "somente leitura"
    body = json.dumps({"call": method, "app_key": creds[0], "app_secret": creds[1], "param": [param]}).encode()
    req = urllib.request.Request(f"{BASE}/{endpoint}/", data=body, headers={"Content-Type": "application/json"})
    for attempt in range(6):
        try:
            with urllib.request.urlopen(req, timeout=120) as r:
                return json.loads(r.read().decode())
        except urllib.error.HTTPError as e:
            text = e.read().decode("utf-8", "replace").lower()
            # O Omie responde 500 quando a consulta não tem nenhum registro (ex.: recebimentos de um ano futuro)
            # e quando a mesma consulta ainda está rodando (aí basta esperar e tentar de novo).
            if e.code == 500 and "não existem registros" in text:
                return {}
            if e.code == 500 and "tentar novamente" in text and attempt < 5:
                time.sleep(10 * (attempt + 1))
                continue
            sys.exit(f"Omie respondeu {e.code} em {method}. Confira a chave e a permissão da empresa.")


def pages(creds, endpoint, method, key, extra=None):
    out, page = [], 1
    while True:
        r = call(creds, endpoint, method, {"pagina": page, "registros_por_pagina": 100, **(extra or {})})
        out += r.get(key, [])
        if page >= r.get("total_de_paginas", 1):
            return out
        page += 1


def q(v):
    return "NULL" if v is None else "'" + str(v).replace("'", "''") + "'"


def payments(creds, years, nature="P"):
    """Movimentos financeiros efetivos pela data do pagamento: P = saídas (pagamentos), R = entradas (recebimentos)."""
    out, page = [], 1
    while True:
        r = call(creds, "financas/mf", "ListarMovimentos", {
            "nPagina": page, "nRegPorPagina": 500, "cNatureza": nature,
            "dDtPagtoDe": f"01/01/{min(years)}", "dDtPagtoAte": f"31/12/{max(years)}"})
        out += r.get("movimentos", [])
        if page >= r.get("nTotPaginas", 1):
            return out
        page += 1


def item_of(obs):
    """Nome do item a partir da observação do título (ex.: "Figma||14/03 FIGMA USD60" → "Figma";
    "Nekt - CY7SCCNQ-0001" → "Nekt"). Textos automáticos do Omie ("Conta a Pagar gerada…", "importada…") não são item."""
    text = re.split(r"\|", (obs or "").split("\n")[0])[0].strip()
    text = re.sub(r"\s*[-–]\s*[A-Za-z0-9-]*\d[A-Za-z0-9-]*\s*$", "", text).strip()
    if not text or text.lower().startswith(("conta a pagar", "importad", "gerad")):
        return ""
    return text[:80]


def split(cats, deps, value):
    """Reparte um valor pelas categorias do título (na proporção de cada uma) e pelos departamentos."""
    base = sum(float(c.get("valor") or 0) for c in cats) or 1
    for c in cats:
        part = value * float(c.get("valor") or 0) / base if len(cats) > 1 else value
        for dep in deps:
            yield c.get("codigo_categoria") or c.get("cCodCateg") or "?", str(dep.get("cCodDep") or ""), part * float(dep.get("nPerDep", 100)) / 100


def sync_company(path, years):
    creds = read_env(path)
    empresas = call(creds, "geral/empresas", "ListarEmpresas", {"pagina": 1, "registros_por_pagina": 5})
    cad = (empresas.get("empresas_cadastro") or [{}])[0]
    name = (cad.get("nome_fantasia") or cad.get("razao_social") or os.path.basename(path)).strip().title()
    departments = pages(creds, "geral/departamentos", "ListarDepartamentos", "departamentos")
    categories = pages(creds, "geral/categorias", "ListarCategorias", "categoria_cadastro")
    payables = pages(creds, "financas/contapagar", "ListarContasPagar", "conta_pagar_cadastro",
                     {"apenas_importado_api": "N", "exibir_obs": "S"})
    titles = {t.get("codigo_lancamento_omie"): t for t in payables}
    no_dep = [{"cCodDep": "", "nPerDep": 100}]

    agg = collections.defaultdict(lambda: [0.0, 0.0])  # (ano, mês, categoria, departamento) → [pago, em aberto]
    status = collections.Counter()
    # Pago: pela data do pagamento efetivo. Títulos de contas a pagar (com a categoria e o departamento do título) e
    # lançamentos feitos direto no extrato. As baixas (BAXP) repetem os títulos e as transferências (TRAP) não são
    # despesa: ficam de fora.
    for m in payments(creds, years):
        d, r = m.get("detalhes") or {}, m.get("resumo") or {}
        paid_on, value = d.get("dDtPagamento") or "", float(r.get("nValPago") or 0)
        if len(paid_on) != 10 or int(paid_on[6:]) not in years or not value:
            continue
        group, origin = d.get("cGrupo"), d.get("cOrigem")
        supplier, item = str(d.get("nCodCliente") or ""), ""
        if group == "CONTA_A_PAGAR":
            t = titles.get(d.get("nCodTitulo")) or {}
            supplier = str(t.get("codigo_cliente_fornecedor") or supplier)
            item = item_of(t.get("observacao"))
            cats = t.get("categorias") or [{"cCodCateg": d.get("cCodCateg"), "valor": value}]
            deps = t.get("distribuicao") or no_dep
            status["pago (título)"] += 1
        elif group == "CONTA_CORRENTE_PAG" and origin not in ("BAXP", "TRAP"):
            cats, deps = [{"cCodCateg": d.get("cCodCateg"), "valor": value}], no_dep
            status["pago (direto no extrato)"] += 1
        else:
            continue
        for cat, dep, part in split(cats, deps, value):
            agg[(int(paid_on[6:]), int(paid_on[3:5]), cat, dep, supplier, item)][0] += part
    # Em aberto: títulos a vencer ou atrasados, pelo vencimento.
    for t in payables:
        st = t.get("status_titulo")
        if st in ("PAGO", "CANCELADO"):
            continue
        due = t.get("data_vencimento") or ""
        if len(due) != 10 or int(due[6:]) not in years:
            continue
        status["em aberto"] += 1
        cats = t.get("categorias") or [{"codigo_categoria": t.get("codigo_categoria"), "valor": t.get("valor_documento", 0)}]
        for cat, dep, part in split(cats, t.get("distribuicao") or no_dep, float(t.get("valor_documento") or 0)):
            agg[(int(due[6:]), int(due[3:5]), cat, dep, str(t.get("codigo_cliente_fornecedor") or ""),
                 item_of(t.get("observacao")))][1] += part
    revenue = receipts(creds, years, no_dep)
    # Nome dos fornecedores e clientes que aparecem nas despesas e receitas (um cadastro só no Omie).
    used = {k[4] for k in agg if k[4]} | {k[4] for k in revenue if k[4]}
    suppliers = {}
    if used:
        for c in pages(creds, "geral/clientes", "ListarClientes", "clientes_cadastro", {"apenas_importado_api": "N"}):
            code = str(c.get("codigo_cliente_omie") or "")
            if code in used:
                suppliers[code] = (c.get("nome_fantasia") or c.get("razao_social") or code).strip()
    return name, departments, categories, agg, status, suppliers, revenue


def receipts(creds, years, no_dep):
    """Receitas por (ano, mês, categoria, departamento, cliente) → [recebido, em aberto]. Recebido: pela data do
    recebimento (títulos de contas a receber e lançamentos direto no extrato; baixas repetidas e transferências fora).
    Em aberto: títulos a vencer ou atrasados, pelo vencimento."""
    titles = {t.get("codigo_lancamento_omie"): t for t in pages(
        creds, "financas/contareceber", "ListarContasReceber", "conta_receber_cadastro", {"apenas_importado_api": "N"})}
    agg = collections.defaultdict(lambda: [0.0, 0.0])
    for m in payments(creds, years, "R"):
        d, r = m.get("detalhes") or {}, m.get("resumo") or {}
        paid_on, value = d.get("dDtPagamento") or "", float(r.get("nValPago") or 0)
        if len(paid_on) != 10 or int(paid_on[6:]) not in years or not value:
            continue
        group, origin = d.get("cGrupo"), d.get("cOrigem")
        client = str(d.get("nCodCliente") or "")
        if group == "CONTA_A_RECEBER":
            t = titles.get(d.get("nCodTitulo")) or {}
            client = str(t.get("codigo_cliente_fornecedor") or client)
            cats = t.get("categorias") or [{"cCodCateg": d.get("cCodCateg"), "valor": value}]
            deps = t.get("distribuicao") or no_dep
        elif group == "CONTA_CORRENTE_REC" and origin not in ("BAXR", "TRAR"):
            cats, deps = [{"cCodCateg": d.get("cCodCateg"), "valor": value}], no_dep
        else:
            continue
        for cat, dep, part in split(cats, deps, value):
            agg[(int(paid_on[6:]), int(paid_on[3:5]), cat, dep, client)][0] += part
    for t in titles.values():
        if t.get("status_titulo") in ("RECEBIDO", "CANCELADO"):
            continue
        due = t.get("data_vencimento") or ""
        if len(due) != 10 or int(due[6:]) not in years:
            continue
        cats = t.get("categorias") or [{"codigo_categoria": t.get("codigo_categoria"), "valor": t.get("valor_documento", 0)}]
        for cat, dep, part in split(cats, t.get("distribuicao") or no_dep, float(t.get("valor_documento") or 0)):
            agg[(int(due[6:]), int(due[3:5]), cat, dep, str(t.get("codigo_cliente_fornecedor") or ""))][1] += part
    return agg


def insert_rows(table, cols, cid, rows, conflict="", size=2000):
    """INSERT em lote: a empresa é buscada uma vez por lote, não por linha."""
    out = []
    for i in range(0, len(rows), size):
        values = ",\n".join("(" + ", ".join(r) + ")" for r in rows[i:i + size])
        out.append(f"INSERT INTO public.{table} (company_id, {', '.join(cols)}) "
                   f"SELECT c.id, v.* FROM {cid} c, (VALUES {values}) AS v({', '.join(cols)}){conflict};")
    return out


def to_sql(companies, years):
    """Uma transação por empresa (lista de scripts), para não mandar tudo num envio só."""
    scripts = []
    yrs = ", ".join(map(str, years))
    for name, departments, categories, agg, _, suppliers, revenue in companies:
        cid = f"(SELECT id FROM public.omie_companies WHERE name = {q(name)})"
        out = ["BEGIN;",
               f"INSERT INTO public.omie_companies (name, last_synced_at) VALUES ({q(name)}, now()) "
               "ON CONFLICT (name) DO UPDATE SET last_synced_at = now();",
               f"DELETE FROM public.omie_departments WHERE company_id = {cid};"]
        out += insert_rows("omie_departments", ["code", "name", "structure"], cid,
                           [[q(d["codigo"]), q(d["descricao"]), q(d.get("estrutura") or "")] for d in departments])
        out.append(f"DELETE FROM public.omie_categories WHERE company_id = {cid};")
        cats = []
        for c in categories:
            parent = c.get("categoria_superior")
            cats.append([q(c["codigo"]), q(c["descricao"]), f"{q(parent if parent not in (None, '', '0') else None)}::TEXT",
                         str(c.get("conta_despesa") == "S"), str(c.get("conta_receita") == "S"), str(c.get("totalizadora") == "S")])
        out += insert_rows("omie_categories", ["code", "name", "parent_code", "is_expense", "is_revenue", "is_total"], cid, cats)
        # Clientes e fornecedores: acumula (ler um ano só não apaga o nome dos que aparecem em outros anos).
        out += insert_rows("omie_suppliers", ["code", "name"], cid,
                           [[q(code), q(sname)] for code, sname in sorted(suppliers.items())],
                           " ON CONFLICT (company_id, code) DO UPDATE SET name = EXCLUDED.name")
        out.append(f"DELETE FROM public.omie_actuals WHERE company_id = {cid} AND year IN ({yrs});")
        out += insert_rows("omie_actuals", ["year", "month", "category_code", "department_code", "supplier_code", "item",
                                            "amount_paid", "amount_open"], cid,
                           [[str(year), str(month), q(cat), q(dep), q(sup), q(item), f"{round(paid, 2)}::NUMERIC",
                             f"{round(opened, 2)}::NUMERIC"]
                            for (year, month, cat, dep, sup, item), (paid, opened) in sorted(agg.items())])
        out.append(f"DELETE FROM public.omie_receipts WHERE company_id = {cid} AND year IN ({yrs});")
        out += insert_rows("omie_receipts", ["year", "month", "category_code", "department_code", "client_code",
                                             "amount_received", "amount_open"], cid,
                           [[str(year), str(month), q(cat), q(dep), q(client), f"{round(got, 2)}::NUMERIC",
                             f"{round(opened, 2)}::NUMERIC"]
                            for (year, month, cat, dep, client), (got, opened) in sorted(revenue.items())])
        out.append("COMMIT;")
        scripts.append((name, "\n".join(out)))
    return scripts


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--env-dir", default=os.path.expanduser("~/Documents/testes_financeiro"))
    ap.add_argument("--year", type=int, action="append",
                    help="ano a ler (padrão: 2026). Para a carteira, inclua o ano do plano (títulos a receber já contratados)")
    ap.add_argument("--target", choices=["linked", "local"], default="linked")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()
    years = args.year or [2026]
    files = sorted(glob.glob(os.path.join(args.env_dir, "omie_*.env")))
    if not files:
        sys.exit(f"Nenhum omie_*.env em {args.env_dir}.")

    companies = []
    for f in files:
        name, departments, categories, agg, status, suppliers, revenue = sync_company(f, years)
        companies.append((name, departments, categories, agg, status, suppliers, revenue))
        total = sum(p + o for p, o in agg.values())
        paid = sum(p for p, _ in agg.values())
        print(f"{name}: {len(departments)} departamentos, {len(categories)} categorias, {len(agg)} linhas de despesa, "
              f"{len(revenue)} de receita, {len(suppliers)} clientes e fornecedores ({', '.join(map(str, years))}): "
              f"despesa R$ {total:,.0f} (pago R$ {paid:,.0f}). Situações: {dict(status)}")
    if args.dry_run:
        print("Simulação: nada foi gravado.")
        return
    for name, sql in to_sql(companies, years):
        with tempfile.NamedTemporaryFile("w", suffix=".sql", delete=False, encoding="utf-8") as tmp:
            tmp.write(sql)
        try:
            if args.target == "local":
                cmd = ["psql", "postgresql://postgres:postgres@127.0.0.1:54322/postgres", "-v", "ON_ERROR_STOP=1", "-q", "-f", tmp.name]
            else:
                cmd = ["supabase", "db", "query", "--linked", "-f", tmp.name]
            done = subprocess.run(cmd, capture_output=True, text=True)
        finally:
            os.unlink(tmp.name)
        if done.returncode != 0:
            # A mensagem do banco pode citar valores: os números saem mascarados.
            msg = re.sub(r"\d", "#", (done.stderr + done.stdout)[-1500:])
            sys.exit(f"Falhou ao gravar {name} ({args.target}); esta empresa ficou como estava.\n{msg}")
        print(f"{name}: gravado no banco ({args.target}).")


if __name__ == "__main__":
    main()
