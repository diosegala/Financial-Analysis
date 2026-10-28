-- Alertas: detectores sobre o realizado do Omie e o plano; quem vê e quem atualiza.
BEGIN;
SELECT plan(10);

CREATE TEMP TABLE ids (k TEXT PRIMARY KEY, id UUID);
GRANT SELECT ON ids TO authenticated;
INSERT INTO ids VALUES
  ('fin', gen_random_uuid()), ('lid', gen_random_uuid()), ('empresa', gen_random_uuid()),
  ('agencia', (SELECT id FROM units WHERE name = 'Agência')),
  ('educacao', (SELECT id FROM units WHERE name = 'Educação')),
  ('versao', (SELECT id FROM budget_versions WHERE name = 'Orçamento 2027'));
CREATE FUNCTION pg_temp.id(_k TEXT) RETURNS UUID LANGUAGE sql AS $$ SELECT id FROM ids WHERE k = _k $$;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA pg_temp TO authenticated;
INSERT INTO auth.users (id, email) VALUES (pg_temp.id('fin'), 'fin@teste'), (pg_temp.id('lid'), 'lid@teste');
INSERT INTO user_roles (user_id, role) VALUES (pg_temp.id('fin'), 'financeiro'), (pg_temp.id('lid'), 'lider');
INSERT INTO user_units (user_id, unit_id) VALUES (pg_temp.id('lid'), pg_temp.id('educacao'));
CREATE FUNCTION pg_temp.login(_k TEXT) RETURNS VOID LANGUAGE sql AS $$
  SELECT set_config('request.jwt.claims', json_build_object('sub', pg_temp.id(_k), 'role', 'authenticated')::TEXT, true);
  SET LOCAL ROLE authenticated;
$$;

INSERT INTO omie_companies (id, name) VALUES (pg_temp.id('empresa'), 'Empresa Teste');
INSERT INTO omie_departments (company_id, code, name, structure) VALUES (pg_temp.id('empresa'), 'd1', 'Agência', '001.001');
INSERT INTO omie_categories (company_id, code, name, is_revenue, is_expense) VALUES
  (pg_temp.id('empresa'), '1.01.02', 'Receitas Fixas', true, false),
  (pg_temp.id('empresa'), '2.01.01', 'Software', false, true);
INSERT INTO omie_suppliers (company_id, code, name) VALUES
  (pg_temp.id('empresa'), 'c1', 'Cliente Antigo'), (pg_temp.id('empresa'), 'c2', 'Cliente Grande'),
  (pg_temp.id('empresa'), 'c3', 'Cliente Pequeno'),
  (pg_temp.id('empresa'), 's1', 'Fornecedor Antigo'), (pg_temp.id('empresa'), 's2', 'Fornecedor Novo');
-- Mês de referência: outubro/2026.
INSERT INTO omie_receipts (company_id, year, month, category_code, department_code, client_code, amount_received, amount_open)
SELECT pg_temp.id('empresa'), 2026, mm, '1.01.02', 'd1', 'c1', 1000, 0 FROM generate_series(5, 8) mm
UNION ALL SELECT pg_temp.id('empresa'), 2026, mm, '1.01.02', 'd1', 'c2', 3000, 0 FROM generate_series(7, 9) mm
UNION ALL SELECT pg_temp.id('empresa'), 2026, 10, '1.01.02', 'd1', 'c2', 1000, 0
UNION ALL SELECT pg_temp.id('empresa'), 2026, 9, '1.01.02', 'd1', 'c3', 100, 0
UNION ALL SELECT pg_temp.id('empresa'), 2025, 10, '1.01.02', 'd1', 'c2', 5000, 0;
INSERT INTO omie_actuals (company_id, year, month, category_code, department_code, supplier_code, item, amount_paid, amount_open)
SELECT pg_temp.id('empresa'), 2026, mm, '2.01.01', 'd1', 's1', '', 1000, 0 FROM generate_series(7, 9) mm
UNION ALL SELECT pg_temp.id('empresa'), 2026, 10, '2.01.01', 'd1', 's1', '', 4000, 0
UNION ALL SELECT pg_temp.id('empresa'), 2026, 10, '2.01.01', 'd1', 's2', '', 6000, 0;

CREATE FUNCTION pg_temp.has(_kind TEXT) RETURNS BOOLEAN LANGUAGE sql AS $$
  SELECT EXISTS (SELECT 1 FROM alerts WHERE kind = _kind)
$$;

SELECT pg_temp.login('fin');
SELECT ok(alerts_refresh(pg_temp.id('versao'), NULL, '2026-10-15') > 0, 'Financeiro roda os detectores');
SELECT ok(pg_temp.has('receita_queda_media'), 'Queda contra a média dos 3 meses anteriores');
SELECT ok(pg_temp.has('receita_queda_ano'), 'Queda contra o mesmo mês do ano anterior');
SELECT is((SELECT title FROM alerts WHERE kind = 'cliente_parou'), 'Cliente Antigo sem recebimento há 2 meses',
  'Cliente recorrente que parou de pagar');
SELECT ok(pg_temp.has('concentracao'), 'Cliente com mais de 30% da receita da unidade');
SELECT ok(pg_temp.has('despesa_alta'), 'Despesa acima da média');
SELECT is((SELECT title FROM alerts WHERE kind = 'fornecedor_novo'), 'Fornecedor novo: Fornecedor Novo',
  'Fornecedor sem pagamento nos 12 meses anteriores');
SELECT ok(pg_temp.has('plano_sem_receita'), 'Unidade sem receita lançada no plano');

RESET ROLE;
SELECT pg_temp.login('lid');
SELECT is((SELECT count(*)::INT FROM alerts WHERE unit_id IS DISTINCT FROM pg_temp.id('educacao')), 0,
  'Líder vê só os alertas das suas unidades');
SELECT throws_ok($$ SELECT alerts_refresh(NULL, NULL, NULL) $$, 'P0001', 'Somente o financeiro atualiza os alertas.',
  'Líder não roda os detectores');

SELECT * FROM finish();
ROLLBACK;
