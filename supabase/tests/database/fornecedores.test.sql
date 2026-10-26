-- Despesas por fornecedor: a base de 2027 tem uma linha por fornecedor dentro da conta.
BEGIN;
SELECT plan(5);

CREATE TEMP TABLE ids (k TEXT PRIMARY KEY, id UUID);
GRANT SELECT ON ids TO authenticated;
INSERT INTO ids VALUES
  ('fin', gen_random_uuid()), ('empresa', gen_random_uuid()),
  ('agencia', (SELECT id FROM units WHERE name = 'Agência')),
  ('versao', (SELECT id FROM budget_versions WHERE name = 'Orçamento 2027'));
CREATE FUNCTION pg_temp.id(_k TEXT) RETURNS UUID LANGUAGE sql AS $$ SELECT id FROM ids WHERE k = _k $$;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA pg_temp TO authenticated;
INSERT INTO auth.users (id, email) VALUES (pg_temp.id('fin'), 'fin@teste');
INSERT INTO user_roles (user_id, role) VALUES (pg_temp.id('fin'), 'financeiro');
CREATE FUNCTION pg_temp.login(_k TEXT) RETURNS VOID LANGUAGE sql AS $$
  SELECT set_config('request.jwt.claims', json_build_object('sub', pg_temp.id(_k), 'role', 'authenticated')::TEXT, true);
  SET LOCAL ROLE authenticated;
$$;

INSERT INTO accounts (name, kind, treatment, dre_line_id, base_name)
VALUES ('SAAS - Agência', 'despesa', 'lancavel', (SELECT id FROM dre_lines WHERE code = 'despesas'), 'SAAS - Agência');
INSERT INTO omie_companies (id, name) VALUES (pg_temp.id('empresa'), 'Empresa Teste');
INSERT INTO omie_categories (company_id, code, name, is_expense) VALUES (pg_temp.id('empresa'), 'c1', 'SAAS - Agência', true);
INSERT INTO omie_suppliers (company_id, code, name) VALUES (pg_temp.id('empresa'), 's1', 'Figma'), (pg_temp.id('empresa'), 's2', 'Adobe');
INSERT INTO omie_actuals (company_id, year, month, category_code, supplier_code, amount_paid, amount_open) VALUES
  (pg_temp.id('empresa'), 2026, 1, 'c1', 's1', 100, 0),
  (pg_temp.id('empresa'), 2026, 2, 'c1', 's1', 100, 0),
  (pg_temp.id('empresa'), 2026, 1, 'c1', 's2', 300, 0),
  (pg_temp.id('empresa'), 2026, 1, 'c1', '', 50, 0);

SELECT pg_temp.login('fin');
SELECT is((SELECT count(*)::INT FROM omie_expense_summary(2026) WHERE category_name = 'SAAS - Agência'), 3,
  'O realizado da categoria abre por fornecedor (2 fornecedores e o que não tem fornecedor)');
SELECT is((SELECT lines FROM generate_expense_base(pg_temp.id('versao'), 0)), 3, 'Uma linha da base por fornecedor');
SELECT is((SELECT SUM(v.amount) FROM plan_lines l JOIN plan_values v ON v.line_id = l.id WHERE l.description = 'Figma'), 200::NUMERIC,
  'A linha do fornecedor tem os meses dele (jan e fev)');
SELECT is((SELECT count(*)::INT FROM plan_lines WHERE origin = 'gerada' AND description = 'Base 2026 (Omie)'), 1,
  'Despesa sem fornecedor vira a linha "Base 2026 (Omie)"');
SELECT is((SELECT SUM(v.amount) FROM plan_lines l JOIN plan_values v ON v.line_id = l.id
           JOIN accounts a ON a.id = l.account_id WHERE a.name = 'SAAS - Agência' AND l.unit_id = pg_temp.id('agencia')), 550::NUMERIC,
  'A conta é a soma dos fornecedores');
SELECT * FROM finish();
ROLLBACK;
