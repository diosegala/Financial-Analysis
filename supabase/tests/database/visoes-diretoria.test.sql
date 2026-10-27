-- Visões da diretoria: natureza da receita (tipo → linha do produto → origem) e critério do rateio do apoio.
BEGIN;
SELECT plan(6);

CREATE TEMP TABLE ids (k TEXT PRIMARY KEY, id UUID);
GRANT SELECT ON ids TO authenticated;
INSERT INTO ids VALUES
  ('fin', gen_random_uuid()), ('lid', gen_random_uuid()),
  ('agencia', (SELECT id FROM units WHERE name = 'Agência')),
  ('educacao', (SELECT id FROM units WHERE name = 'Educação')),
  ('versao', (SELECT id FROM budget_versions WHERE name = 'Orçamento 2027')),
  ('cenario', (SELECT s.id FROM scenarios s JOIN budget_versions v ON v.id = s.version_id
               WHERE v.name = 'Orçamento 2027' AND s.name = 'Realista')),
  ('conta', (SELECT id FROM accounts WHERE kind = 'receita' ORDER BY sort_order LIMIT 1)),
  ('comunidade', (SELECT id FROM product_lines WHERE name = 'Comunidade'));
CREATE FUNCTION pg_temp.id(_k TEXT) RETURNS UUID LANGUAGE sql AS $$ SELECT id FROM ids WHERE k = _k $$;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA pg_temp TO authenticated;
INSERT INTO auth.users (id, email) VALUES (pg_temp.id('fin'), 'fin@teste'), (pg_temp.id('lid'), 'lid@teste');
INSERT INTO user_roles (user_id, role) VALUES (pg_temp.id('fin'), 'financeiro'), (pg_temp.id('lid'), 'lider');
INSERT INTO user_units (user_id, unit_id) VALUES (pg_temp.id('lid'), pg_temp.id('educacao'));
CREATE FUNCTION pg_temp.login(_k TEXT) RETURNS VOID LANGUAGE sql AS $$
  SELECT set_config('request.jwt.claims', json_build_object('sub', pg_temp.id(_k), 'role', 'authenticated')::TEXT, true);
  SET LOCAL ROLE authenticated;
$$;

UPDATE scenarios SET revenue_variation = 0 WHERE id = pg_temp.id('cenario');
INSERT INTO products (id, name, unit_id, kind, line_id)
VALUES (gen_random_uuid(), 'Assinatura teste', pg_temp.id('educacao'), 'servico', pg_temp.id('comunidade'));
WITH l AS (
  INSERT INTO plan_lines (version_id, unit_id, account_id, description, revenue_type_id, product_id, revenue_origin)
  VALUES
    -- tipo recorrente vence a linha de produto
    (pg_temp.id('versao'), pg_temp.id('agencia'), pg_temp.id('conta'), 'fee',
     (SELECT id FROM revenue_types WHERE name = 'Recorrente 12 meses'), NULL, 'nova'),
    -- produto de linha recorrente
    (pg_temp.id('versao'), pg_temp.id('educacao'), pg_temp.id('conta'), 'assinatura', NULL,
     (SELECT id FROM products WHERE name = 'Assinatura teste'), 'nova'),
    -- sem tipo e sem produto: carteira é recorrente, nova é variável
    (pg_temp.id('versao'), pg_temp.id('educacao'), pg_temp.id('conta'), 'carteira', NULL, NULL, 'carteira'),
    (pg_temp.id('versao'), pg_temp.id('educacao'), pg_temp.id('conta'), 'turma', NULL, NULL, 'nova')
  RETURNING id, description
)
INSERT INTO plan_values (line_id, month, amount)
SELECT id, 1, CASE description WHEN 'fee' THEN 100 WHEN 'assinatura' THEN 200 WHEN 'carteira' THEN 300 ELSE 400 END
FROM l;

CREATE FUNCTION pg_temp.nat(_unit TEXT, _nature TEXT) RETURNS NUMERIC LANGUAGE sql AS $$
  SELECT COALESCE(SUM(amount), 0) FROM revenue_by_nature(pg_temp.id('versao'), pg_temp.id('cenario'), ARRAY[pg_temp.id(_unit)])
  WHERE nature = _nature AND month = 1
$$;

SELECT pg_temp.login('fin');
SELECT is(pg_temp.nat('agencia', 'recorrente'), 100::NUMERIC, 'Tipo de receita recorrente conta como recorrente');
SELECT is(pg_temp.nat('educacao', 'recorrente'), 500::NUMERIC, 'Linha de produto recorrente e carteira contam como recorrente');
SELECT is(pg_temp.nat('educacao', 'variavel'), 400::NUMERIC, 'Venda nova sem tipo nem produto é variável');
SELECT lives_ok($$ INSERT INTO support_shares (scenario_id, unit_id, share) VALUES (pg_temp.id('cenario'), pg_temp.id('agencia'), 1) $$,
  'Financeiro grava o critério do rateio');

RESET ROLE;
SELECT pg_temp.login('lid');
SELECT is((SELECT count(*)::INT FROM support_shares), 0, 'Líder não vê o critério do rateio');
SELECT is(pg_temp.nat('agencia', 'recorrente'), 0::NUMERIC, 'Líder não vê a receita de outra unidade');

SELECT * FROM finish();
ROLLBACK;
