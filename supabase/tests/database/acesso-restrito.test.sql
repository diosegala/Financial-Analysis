-- Login sem perfil não lê nada; o realizado do Omie por cliente e fornecedor só sai pelas funções que conferem o perfil.
BEGIN;
SELECT plan(9);

CREATE TEMP TABLE ids (k TEXT PRIMARY KEY, id UUID);
GRANT SELECT ON ids TO authenticated;
INSERT INTO ids VALUES ('fin', gen_random_uuid()), ('lid', gen_random_uuid()), ('sem', gen_random_uuid()),
  ('agencia', (SELECT id FROM units WHERE name = 'Agência'));
CREATE FUNCTION pg_temp.id(_k TEXT) RETURNS UUID LANGUAGE sql AS $$ SELECT id FROM ids WHERE k = _k $$;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA pg_temp TO authenticated;
INSERT INTO auth.users (id, email) VALUES
  (pg_temp.id('fin'), 'fin@teste'), (pg_temp.id('lid'), 'lid@teste'), (pg_temp.id('sem'), 'sem@teste');
INSERT INTO user_roles (user_id, role) VALUES (pg_temp.id('fin'), 'financeiro'), (pg_temp.id('lid'), 'lider');
INSERT INTO user_units (user_id, unit_id) VALUES (pg_temp.id('lid'), pg_temp.id('agencia'));
CREATE FUNCTION pg_temp.login(_k TEXT) RETURNS VOID LANGUAGE sql AS $$
  SELECT set_config('request.jwt.claims', json_build_object('sub', pg_temp.id(_k), 'role', 'authenticated')::TEXT, true);
  SET LOCAL ROLE authenticated;
$$;

SELECT pg_temp.login('sem');
SELECT is((SELECT count(*) FROM units), 0::BIGINT, 'Sem perfil: não lê as unidades');
SELECT is((SELECT count(*) FROM accounts), 0::BIGINT, 'Sem perfil: não lê o plano de contas');
SELECT is((SELECT count(*) FROM clients), 0::BIGINT, 'Sem perfil: não lê os clientes');
SELECT is((SELECT count(*) FROM parameter_values), 0::BIGINT, 'Sem perfil: não lê os parâmetros');
SELECT throws_ok($$ SELECT * FROM omie_revenue_attribution(2026) $$, '42501', NULL,
  'Sem perfil: não chama o realizado de receitas do Omie');

RESET ROLE;
SELECT pg_temp.login('lid');
SELECT ok((SELECT count(*) FROM units) > 0, 'Líder continua lendo as unidades');
SELECT throws_ok($$ SELECT * FROM omie_expense_attribution(2026) $$, '42501', NULL,
  'Líder não chama o realizado por fornecedor direto');

RESET ROLE;
SELECT pg_temp.login('fin');
SELECT ok((SELECT count(*) FROM accounts) > 0, 'Financeiro continua lendo as contas');
SELECT lives_ok($$ SELECT * FROM omie_revenue_summary(2026) $$,
  'Financeiro continua vendo o realizado pelo resumo do Omie');

RESET ROLE;
SELECT * FROM finish();
ROLLBACK;
