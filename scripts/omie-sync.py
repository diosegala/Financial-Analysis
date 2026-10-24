#!/usr/bin/env python3
"""Lê o realizado do Omie (SOMENTE LEITURA) e grava no banco do planejamento.

  python3 scripts/omie-sync.py --dry-run                 # só mostra o resumo, não grava
  python3 scripts/omie-sync.py                           # projeto real (precisa de `supabase login` e `supabase link`)
  python3 scripts/omie-sync.py --target local            # banco local, para testes
  python3 scripts/omie-sync.py --year 2025 --year 2026   # mais de um ano

Uma empresa por arquivo, na pasta --env-dir (padrão ~/Documents/testes_financeiro): omie_central.env, omie_pw.env,
omie_mktimob.env… Cada arquivo tem OMIE_APP_KEY e OMIE_APP_SECRET. As chaves nunca são impressas nem gravadas no
banco, e só métodos Listar* são chamados: o Omie não recebe nenhuma escrita.

Grava, por empresa: departamentos, categorias e as contas a pagar somadas por mês (data de emissão do título),
categoria e departamento, separando pagas de em aberto. Títulos cancelados ficam de fora. Rodar de novo troca o
que existe daquele ano para a empresa.
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


def sync_company(path, years):
    creds = read_env(path)
    empresas = call(creds, "geral/empresas", "ListarEmpresas", {"pagina": 1, "registros_por_pagina": 5})
    cad = (empresas.get("empresas_cadastro") or [{}])[0]
    name = (cad.get("nome_fantasia") or cad.get("razao_social") or os.path.basename(path)).strip().title()
    departments = pages(creds, "geral/departamentos", "ListarDepartamentos", "departamentos")
    categories = pages(creds, "geral/categorias", "ListarCategorias", "categoria_cadastro")
    payables = pages(creds, "financas/contapagar", "ListarContasPagar", "conta_pagar_cadastro", {"apenas_importado_api": "N"})

    agg = collections.defaultdict(lambda: [0.0, 0.0])  # (ano, mês, categoria, departamento) → [pago, em aberto]
    status = collections.Counter()
    for t in payables:
        status[t.get("status_titulo")] += 1
        if t.get("status_titulo") == "CANCELADO":
            continue
        d = t.get("data_emissao") or ""
        if len(d) != 10 or int(d[6:]) not in years:
            continue
        year, month = int(d[6:]), int(d[3:5])
        paid = t.get("status_titulo") == "PAGO"
        cats = t.get("categorias") or [{"codigo_categoria": t.get("codigo_categoria"), "valor": t.get("valor_documento", 0)}]
        deps = t.get("distribuicao") or [{"cCodDep": "", "nPerDep": 100}]
        for c in cats:
            for dep in deps:
                value = float(c.get("valor", 0)) * float(dep.get("nPerDep", 100)) / 100
                agg[(year, month, c.get("codigo_categoria") or "?", str(dep.get("cCodDep") or ""))][0 if paid else 1] += value
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
