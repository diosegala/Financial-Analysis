-- Ordem dos lançamentos escolhida na grade: grava a posição de cada linha, só onde o usuário pode editar.
BEGIN;
SELECT plan(3);

CREATE TEMP TABLE ids (k TEXT PRIMARY KEY, id UUID);
GRANT SELECT ON ids TO authenticated;
INSERT INTO ids VALUES
  ('lider', gen_random_uuid()), ('a', gen_random_uuid()), ('b', gen_random_uuid()), ('c', gen_random_uuid()),
  ('consultoria', (SELECT id FROM units WHERE name = 'Consultoria')),
  ('agencia', (SELECT id FROM units WHERE name = 'Agência')),
  ('versao', (SELECT id FROM budget_versions WHERE name = 'Orçamento 2027')),
  ('rec', (SELECT id FROM accounts WHERE kind = 'receita' AND treatment = 'lancavel' AND unit_ids IS NULL ORDER BY name LIMIT 1));
CREATE FUNCTION pg_temp.id(_k TEXT) RETURNS UUID LANGUAGE sql AS $$ SELECT id FROM ids WHERE k = _k $$;
INSERT INTO plan_lines (id, version_id, unit_id, account_id, description) VALUES
  (pg_temp.id('a'), pg_temp.id('versao'), pg_temp.id('consultoria'), pg_temp.id('rec'), 'Cliente A'),
  (pg_temp.id('b'), pg_temp.id('versao'), pg_temp.id('consultoria'), pg_temp.id('rec'), 'Cliente B'),
  (pg_temp.id('c'), pg_temp.id('versao'), pg_temp.id('agencia'), pg_temp.id('rec'), 'Cliente C');
INSERT INTO auth.users (id, email) VALUES (pg_temp.id('lider'), 'lider@teste');
INSERT INTO user_roles (user_id, role) VALUES (pg_temp.id('lider'), 'lider');
INSERT INTO user_units (user_id, unit_id) VALUES (pg_temp.id('lider'), pg_temp.id('consultoria'));

SELECT set_config('request.jwt.claims', json_build_object('sub', pg_temp.id('lider'), 'role', 'authenticated')::TEXT, true);
SET LOCAL ROLE authenticated;
SELECT plan_lines_reorder(ARRAY[pg_temp.id('b'), pg_temp.id('a'), pg_temp.id('c')]);
RESET ROLE;

SELECT is((SELECT sort_order FROM plan_lines WHERE id = pg_temp.id('b')), 1, 'B vai para o topo');
SELECT is((SELECT sort_order FROM plan_lines WHERE id = pg_temp.id('a')), 2, 'A desce');
SELECT is((SELECT sort_order FROM plan_lines WHERE id = pg_temp.id('c')), 0, 'A linha de outra unidade não muda');

SELECT * FROM finish();
ROLLBACK;
