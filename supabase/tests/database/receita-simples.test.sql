-- Receita sem tipo: o líder lança só descrição, origem e valores; a comissão geral continua valendo.
BEGIN;
SELECT plan(4);

CREATE TEMP TABLE ids (k TEXT PRIMARY KEY, id UUID);
GRANT SELECT ON ids TO authenticated;
INSERT INTO ids VALUES
  ('lid', gen_random_uuid()),
  ('consultoria', (SELECT id FROM units WHERE name = 'Consultoria')),
  ('versao', (SELECT id FROM budget_versions WHERE name = 'Orçamento 2027')),
  ('realista', (SELECT id FROM scenarios WHERE name = 'Realista'));
CREATE FUNCTION pg_temp.id(_k TEXT) RETURNS UUID LANGUAGE sql AS $$ SELECT id FROM ids WHERE k = _k $$;
CREATE FUNCTION pg_temp.pd(_k TEXT) RETURNS UUID LANGUAGE sql AS $$ SELECT id FROM parameter_definitions WHERE key = _k $$;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA pg_temp TO authenticated;
INSERT INTO auth.users (id, email) VALUES (pg_temp.id('lid'), 'lid@teste');
INSERT INTO user_roles (user_id, role) VALUES (pg_temp.id('lid'), 'lider');
INSERT INTO user_units (user_id, unit_id) VALUES (pg_temp.id('lid'), pg_temp.id('consultoria'));
INSERT INTO parameter_values (definition_id, value, valid_from) VALUES
  (pg_temp.pd('comissao_comercial'), 0.10, '2027-01-01'), (pg_temp.pd('comissao_parceiro'), 0.20, '2027-01-01');
CREATE FUNCTION pg_temp.login(_k TEXT) RETURNS VOID LANGUAGE sql AS $$
  SELECT set_config('request.jwt.claims', json_build_object('sub', pg_temp.id(_k), 'role', 'authenticated')::TEXT, true);
  SET LOCAL ROLE authenticated;
$$;

SELECT is((SELECT revenue_type_ids FROM calc_rules WHERE name = 'Comissão comercial'), NULL::UUID[],
  'Comissão comercial vira "todos, exceto Parceiros"');
SELECT pg_temp.login('lid');
SELECT lives_ok($$
  SELECT launch_line(pg_temp.id('versao'), pg_temp.id('consultoria'), (SELECT id FROM accounts WHERE name = 'Receita de serviços'),
    'Carteira Consultoria', NULL, NULL, NULL, '[{"month": 1, "amount": 1000}]'::JSONB, NULL, 'carteira')
$$, 'Líder lança receita sem tipo de receita');
SELECT is((SELECT ROUND(amount, 2) FROM dre_report(pg_temp.id('versao'), pg_temp.id('realista'), ARRAY[pg_temp.id('consultoria')])
           WHERE dre_line_id = (SELECT id FROM dre_lines WHERE code = 'comissionamento') AND month = 1), 100.00,
  'Receita sem tipo paga a comissão geral (10%), não a de parceiros');
SELECT is((SELECT count(*)::INT FROM plan_lines WHERE description = 'Carteira Consultoria' AND revenue_type_id IS NULL), 1,
  'A linha fica gravada sem tipo');
SELECT * FROM finish();
ROLLBACK;
