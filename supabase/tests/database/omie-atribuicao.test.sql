-- Atribuição do realizado às unidades: escolha do financeiro (rateio) > departamento > palavra no nome > a ratear.
BEGIN;
SELECT plan(11);

CREATE TEMP TABLE ids (k TEXT PRIMARY KEY, id UUID);
GRANT SELECT ON ids TO authenticated;
INSERT INTO ids VALUES
  ('fin', gen_random_uuid()), ('lid', gen_random_uuid()), ('empresa', gen_random_uuid()),
  ('agencia', (SELECT id FROM units WHERE name = 'Agência')),
  ('consultoria', (SELECT id FROM units WHERE name = 'Consultoria')),
  ('educacao', (SELECT id FROM units WHERE name = 'Educação')),
  ('financeiro', (SELECT id FROM units WHERE name = 'Financeiro'));
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
INSERT INTO omie_categories (company_id, code, name, is_expense) VALUES
  (pg_temp.id('empresa'), 'c1', 'SAAS - Agência', true),
  (pg_temp.id('empresa'), 'c2', 'CUPOLA Summit - 2026', true),
  (pg_temp.id('empresa'), 'c3', 'Financeiro Essencial - 2026', true),
  (pg_temp.id('empresa'), 'c4', 'SAAS - Financeiro', true),
  (pg_temp.id('empresa'), 'c5', 'Marketing e Publicidade', true),
  (pg_temp.id('empresa'), 'c6', 'Infraestrutura', true),
  (pg_temp.id('empresa'), 'c7', 'Processos Administrativos e Financeiros da Locação', true);
INSERT INTO omie_actuals (company_id, year, month, category_code, department_code, amount_paid, amount_open) VALUES
  (pg_temp.id('empresa'), 2026, 1, 'c1', '', 100, 0),
  (pg_temp.id('empresa'), 2026, 1, 'c2', '', 200, 0),
  (pg_temp.id('empresa'), 2026, 1, 'c3', '', 300, 0),
  (pg_temp.id('empresa'), 2026, 1, 'c4', '', 400, 0),
  (pg_temp.id('empresa'), 2026, 1, 'c5', '', 1000, 0),
  (pg_temp.id('empresa'), 2026, 1, 'c5', 'd1', 50, 0),
  (pg_temp.id('empresa'), 2026, 1, 'c6', '', 70, 0),
  (pg_temp.id('empresa'), 2026, 1, 'c7', '', 90, 0);

SELECT pg_temp.login('fin');
CREATE FUNCTION pg_temp.v(_cat TEXT, _unit TEXT, _src TEXT) RETURNS NUMERIC LANGUAGE sql AS $$
  SELECT paid[1] + open[1] FROM omie_expense_summary(2026)
  WHERE category_name = _cat AND unit_id IS NOT DISTINCT FROM (SELECT id FROM ids WHERE k = _unit) AND source = _src
$$;
GRANT EXECUTE ON FUNCTION pg_temp.v(TEXT, TEXT, TEXT) TO authenticated;

SELECT is(pg_temp.v('SAAS - Agência', 'agencia', 'palavra'), 100::NUMERIC, 'Palavra no nome: SAAS - Agência vai para a Agência');
SELECT is(pg_temp.v('CUPOLA Summit - 2026', 'educacao', 'palavra'), 200::NUMERIC, 'Eventos e treinamentos vão para a Educação (Summit)');
SELECT is(pg_temp.v('Financeiro Essencial - 2026', 'educacao', 'palavra'), 300::NUMERIC,
  'Prioridade: "Financeiro Essencial" (treinamento) vence "Financeiro" (a unidade)');
SELECT is(pg_temp.v('SAAS - Financeiro', 'financeiro', 'palavra'), 400::NUMERIC, 'A palavra Financeiro continua valendo para o resto');
SELECT is(pg_temp.v('Processos Administrativos e Financeiros da Locação', 'educacao', 'palavra'), 90::NUMERIC,
  'Frase mais longa e de maior prioridade vence a palavra solta (Financeiros)');
SELECT is(pg_temp.v('Infraestrutura', NULL, 'sem'), 70::NUMERIC, 'Sem palavra nem rateio: fica a ratear');
SELECT is(pg_temp.v('Marketing e Publicidade', NULL, 'sem'), 1000::NUMERIC, 'Marketing a ratear antes do rateio');

-- Rateio: 40% Agência, 60% Consultoria (soma 100); vale também para o título lançado com departamento
INSERT INTO omie_category_allocations (category_name, unit_id, share) VALUES
  ('Marketing e Publicidade', pg_temp.id('agencia'), 0.4), ('marketing e publicidade', pg_temp.id('consultoria'), 0.6);
SELECT is(pg_temp.v('Marketing e Publicidade', 'agencia', 'rateio'), 420::NUMERIC, 'Rateio: 40% de 1.050 para a Agência');
SELECT is(pg_temp.v('Marketing e Publicidade', 'consultoria', 'rateio'), 630::NUMERIC, 'Rateio: 60% para a Consultoria (nome sem diferenciar caixa)');
SELECT is(pg_temp.v('Marketing e Publicidade', 'agencia', 'departamento'), NULL::NUMERIC,
  'A escolha do financeiro vence o departamento do título (corrige título lançado no departamento errado)');

SELECT pg_temp.login('lid');
SELECT is((SELECT count(*)::INT FROM omie_expense_summary(2026) WHERE unit_id IS DISTINCT FROM pg_temp.id('educacao')), 0,
  'Líder da Educação só vê o que é da Educação');
SELECT * FROM finish();
ROLLBACK;
