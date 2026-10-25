#!/usr/bin/env python3
"""Lê o realizado do Omie (SOMENTE LEITURA) e grava no banco do planejamento.

  python3 scripts/omie-sync.py --dry-run                 # só mostra o resumo, não grava
  python3 scripts/omie-sync.py                           # projeto real (precisa de `supabase login` e `supabase link`)
  python3 scripts/omie-sync.py --target local            # banco local, para testes
  python3 scripts/omie-sync.py --year 2025 --year 2026   # mais de um ano

Uma empresa por arquivo, na pasta --env-dir (padrão ~/Documents/testes_financeiro): omie_central.env, omie_pw.env,
omie_mktimob.env… Cada arquivo tem OMIE_APP_KEY e OMIE_APP_SECRET. As chaves nunca são impressas nem gravadas no
banco, e só métodos Listar* são chamados: o Omie não recebe nenhuma escrita.

Grava, por empresa: departamentos, categorias e as despesas por mês, categoria e departamento. "Pago" é o pagamento
efetivo, pela data em que foi pago (títulos de contas a pagar e lançamentos feitos direto no extrato); "em aberto"
são os títulos a vencer ou atrasados, pelo vencimento. Cancelados, baixas repetidas e transferências entre contas
ficam de fora. Rodar de novo troca o que existe daquele ano para a empresa.
"""
import argparse
import collections
import glob
import json
import os
import subprocess
import sys
import tempfile
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
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            return json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
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


def payments(creds, years):
    """Pagamentos efetivos (movimentos financeiros de saída), pela data de pagamento."""
    out, page = [], 1
    while True:
        r = call(creds, "financas/mf", "ListarMovimentos", {
            "nPagina": page, "nRegPorPagina": 500, "cNatureza": "P",
            "dDtPagtoDe": f"01/01/{min(years)}", "dDtPagtoAte": f"31/12/{max(years)}"})
        out += r.get("movimentos", [])
        if page >= r.get("nTotPaginas", 1):
            return out
        page += 1


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
    payables = pages(creds, "financas/contapagar", "ListarContasPagar", "conta_pagar_cadastro", {"apenas_importado_api": "N"})
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
        if group == "CONTA_A_PAGAR":
            t = titles.get(d.get("nCodTitulo")) or {}
            cats = t.get("categorias") or [{"cCodCateg": d.get("cCodCateg"), "valor": value}]
            deps = t.get("distribuicao") or no_dep
            status["pago (título)"] += 1
        elif group == "CONTA_CORRENTE_PAG" and origin not in ("BAXP", "TRAP"):
            cats, deps = [{"cCodCateg": d.get("cCodCateg"), "valor": value}], no_dep
            status["pago (direto no extrato)"] += 1
        else:
            continue
        for cat, dep, part in split(cats, deps, value):
            agg[(int(paid_on[6:]), int(paid_on[3:5]), cat, dep)][0] += part
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
            agg[(int(due[6:]), int(due[3:5]), cat, dep)][1] += part
    return name, departments, categories, agg, status


def to_sql(companies, years):
    out = ["BEGIN;"]
    for name, departments, categories, agg, _ in companies:
        cid = f"(SELECT id FROM public.omie_companies WHERE name = {q(name)})"
        out.append(f"INSERT INTO public.omie_companies (name, last_synced_at) VALUES ({q(name)}, now()) "
                   "ON CONFLICT (name) DO UPDATE SET last_synced_at = now();")
        out.append(f"DELETE FROM public.omie_departments WHERE company_id = {cid};")
        for d in departments:
            out.append("INSERT INTO public.omie_departments (company_id, code, name, structure) VALUES "
                       f"({cid}, {q(d['codigo'])}, {q(d['descricao'])}, {q(d.get('estrutura') or '')});")
        out.append(f"DELETE FROM public.omie_categories WHERE company_id = {cid};")
        for c in categories:
            parent = c.get("categoria_superior")
            out.append("INSERT INTO public.omie_categories (company_id, code, name, parent_code, is_expense, is_revenue, is_total) VALUES "
                       f"({cid}, {q(c['codigo'])}, {q(c['descricao'])}, {q(parent if parent not in (None, '', '0') else None)}, "
                       f"{c.get('conta_despesa') == 'S'}, {c.get('conta_receita') == 'S'}, {c.get('totalizadora') == 'S'});")
        out.append(f"DELETE FROM public.omie_actuals WHERE company_id = {cid} AND year IN ({', '.join(map(str, years))});")
        for (year, month, cat, dep), (paid, opened) in sorted(agg.items()):
            out.append("INSERT INTO public.omie_actuals (company_id, year, month, category_code, department_code, amount_paid, amount_open) VALUES "
                       f"({cid}, {year}, {month}, {q(cat)}, {q(dep)}, {round(paid, 2)}, {round(opened, 2)});")
    out.append("COMMIT;")
    return "\n".join(out)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--env-dir", default=os.path.expanduser("~/Documents/testes_financeiro"))
    ap.add_argument("--year", type=int, action="append", help="ano a ler (padrão: 2026)")
    ap.add_argument("--target", choices=["linked", "local"], default="linked")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()
    years = args.year or [2026]
    files = sorted(glob.glob(os.path.join(args.env_dir, "omie_*.env")))
    if not files:
        sys.exit(f"Nenhum omie_*.env em {args.env_dir}.")

    companies = []
    for f in files:
        name, departments, categories, agg, status = sync_company(f, years)
        companies.append((name, departments, categories, agg, status))
        total = sum(p + o for p, o in agg.values())
        paid = sum(p for p, _ in agg.values())
        print(f"{name}: {len(departments)} departamentos, {len(categories)} categorias, {len(agg)} linhas de realizado "
              f"({', '.join(map(str, years))}): R$ {total:,.0f} (pago R$ {paid:,.0f}). Situações: {dict(status)}")
    if args.dry_run:
        print("Simulação: nada foi gravado.")
        return
    with tempfile.NamedTemporaryFile("w", suffix=".sql", delete=False, encoding="utf-8") as tmp:
        tmp.write(to_sql(companies, years))
    try:
        if args.target == "local":
            cmd = ["psql", "postgresql://postgres:postgres@127.0.0.1:54322/postgres", "-v", "ON_ERROR_STOP=1", "-q", "-f", tmp.name]
        else:
            cmd = ["supabase", "db", "query", "--linked", "-f", tmp.name]
        subprocess.run(cmd, check=True, stdout=subprocess.DEVNULL)
    finally:
        os.unlink(tmp.name)
    print(f"Gravado no banco ({args.target}).")


if __name__ == "__main__":
    main()
