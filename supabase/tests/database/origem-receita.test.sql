-- O líder quebra a meta: origem da receita (carteira, renovação, nova) e o saldo a vender.
BEGIN;
SELECT plan(9);

CREATE TEMP TABLE ids (k TEXT PRIMARY KEY, id UUID);
GRANT SELECT, INSERT ON ids TO authenticated;
INSERT INTO ids VALUES
  ('fin', gen_random_uuid()), ('lid', gen_random_uuid()),
  ('consultoria', (SELECT id FROM units WHERE name = 'Consultoria')),
  ('agencia', (SELECT id FROM units WHERE name = 'Agência')),
  ('versao', (SELECT id FROM budget_versions WHERE name = 'Orçamento 2027')),
  ('realista', (SELECT id FROM scenarios WHERE name = 'Realista'));
CREATE FUNCTION pg_temp.id(_k TEXT) RETURNS UUID LANGUAGE sql AS $$ SELECT id FROM ids WHERE k = _k $$;
CREATE FUNCTION pg_temp.acc(_n TEXT) RETURNS UUID LANGUAGE sql AS $$ SELECT id FROM accounts WHERE name = _n $$;
CREATE FUNCTION pg_temp.rt(_n TEXT) RETURNS UUID LANGUAGE sql AS $$ SELECT id FROM revenue_types WHERE name = _n $$;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA pg_temp TO authenticated;
INSERT INTO auth.users (id, email) VALUES (pg_temp.id('fin'), 'fin@teste'), (pg_temp.id('lid'), 'lid@teste');
INSERT INTO user_roles (user_id, role) VALUES (pg_temp.id('fin'), 'financeiro'), (pg_temp.id('lid'), 'lider');
INSERT INTO user_units (user_id, unit_id) VALUES (pg_temp.id('lid'), pg_temp.id('consultoria'));
CREATE FUNCTION pg_temp.login(_k TEXT) RETURNS VOID LANGUAGE sql AS $$
  SELECT set_config('request.jwt.claims', json_build_object('sub', pg_temp.id(_k), 'role', 'authenticated')::TEXT, true);
  SET LOCAL ROLE authenticated;
$$;
CREATE FUNCTION pg_temp.tvp(_unit TEXT, _month INT, _col TEXT) RETURNS NUMERIC LANGUAGE sql AS $$
  SELECT CASE _col WHEN 'target' THEN target WHEN 'carteira' THEN carteira WHEN 'renovacao' THEN renovacao
                   WHEN 'nova' THEN nova ELSE sem_origem END
  FROM target_vs_plan(pg_temp.id('versao'), pg_temp.id('realista')) WHERE unit_id = pg_temp.id(_unit) AND month = _month
$$;
GRANT EXECUTE ON FUNCTION pg_temp.tvp(TEXT, INT, TEXT) TO authenticated;

-- Meta publicada: Consultoria 10.000 em janeiro
INSERT INTO scenario_targets (scenario_id, published_at, feasible) VALUES (pg_temp.id('realista'), now(), true);
INSERT INTO revenue_targets (scenario_id, unit_id, month, amount) VALUES
  (pg_temp.id('realista'), pg_temp.id('consultoria'), 1, 10000), (pg_temp.id('realista'), pg_temp.id('agencia'), 1, 5000);

SELECT pg_temp.login('lid');
-- O líder lança por launch_line, com a origem de cada linha
SELECT lives_ok($$
  SELECT launch_line(pg_temp.id('versao'), pg_temp.id('consultoria'), pg_temp.acc('Receita de serviços'), 'Carteira', NULL, NULL,
    pg_temp.rt('Recorrente 12 meses'), '[{"month": 1, "amount": 4000}]'::JSONB, NULL, 'carteira')
$$, 'Líder lança receita de carteira');
SELECT launch_line(pg_temp.id('versao'), pg_temp.id('consultoria'), pg_temp.acc('Receita de serviços'), 'Renovação', NULL, NULL,
  pg_temp.rt('Recorrente 12 meses'), '[{"month": 1, "amount": 1500}]'::JSONB, NULL, 'renovacao');
SELECT launch_line(pg_temp.id('versao'), pg_temp.id('consultoria'), pg_temp.acc('Receita de serviços'), 'Nova', NULL, NULL,
  pg_temp.rt('Recorrente 12 meses'), '[{"month": 1, "amount": 2000}]'::JSONB, NULL, 'nova');
SELECT launch_line(pg_temp.id('versao'), pg_temp.id('consultoria'), pg_temp.acc('Receita de serviços'), 'Antiga', NULL, NULL,
  pg_temp.rt('Recorrente 12 meses'), '[{"month": 1, "amount": 300}]'::JSONB, NULL, NULL);
SELECT throws_ok($$
  SELECT launch_line(pg_temp.id('versao'), pg_temp.id('consultoria'), pg_temp.acc('Receita de serviços'), 'x', NULL, NULL,
    pg_temp.rt('Recorrente 12 meses'), '[]'::JSONB, NULL, 'invalida')
$$, '23514', NULL, 'Origem fora da lista é recusada');

SELECT is(pg_temp.tvp('consultoria', 1, 'target'), 10000::NUMERIC, 'Líder vê a meta publicada da unidade');
SELECT is(pg_temp.tvp('consultoria', 1, 'carteira'), 4000::NUMERIC, 'Carteira de janeiro');
SELECT is(pg_temp.tvp('consultoria', 1, 'renovacao'), 1500::NUMERIC, 'Renovações de janeiro');
SELECT is(pg_temp.tvp('consultoria', 1, 'nova'), 2000::NUMERIC, 'Vendas novas planejadas');
SELECT is(pg_temp.tvp('consultoria', 1, 'sem'), 300::NUMERIC, 'Linhas sem origem aparecem à parte');
-- saldo a vender = 10.000 − 4.000 − 1.500 = 4.500; falta = 4.500 − 2.000 = 2.500 (calculados na tela)
SELECT is((SELECT count(*)::INT FROM target_vs_plan(pg_temp.id('versao'), pg_temp.id('realista')) WHERE unit_id = pg_temp.id('agencia')), 0,
  'Líder não vê a meta de outra unidade');

SELECT pg_temp.login('fin');
INSERT INTO ids VALUES ('copia', copy_version(pg_temp.id('versao'), 'Cópia', 2028));
SELECT is((SELECT count(*)::INT FROM plan_lines WHERE version_id = pg_temp.id('copia') AND revenue_origin = 'renovacao'), 1,
  'A cópia da versão mantém a origem da receita');
SELECT * FROM finish();
ROLLBACK;
