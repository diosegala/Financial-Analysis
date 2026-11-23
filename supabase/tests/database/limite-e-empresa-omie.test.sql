-- O limite de despesas segue o ano base corrigido na hora, e a leitura do Omie acha a empresa pelo CNPJ quando o nome muda.
BEGIN;
SELECT plan(7);

CREATE TEMP TABLE ids (k TEXT PRIMARY KEY, id UUID);
INSERT INTO ids VALUES
  ('fin', gen_random_uuid()),
  ('agencia', (SELECT id FROM units WHERE name = 'Agência')),
  ('conta', (SELECT id FROM accounts WHERE kind = 'despesa' AND treatment = 'lancavel' AND active ORDER BY name LIMIT 1)),
  ('cenario', (SELECT s.id FROM scenarios s JOIN budget_versions v ON v.id = s.version_id
               WHERE v.name = 'Orçamento 2027' ORDER BY s.created_at LIMIT 1));
CREATE FUNCTION pg_temp.id(_k TEXT) RETURNS UUID LANGUAGE sql AS $$ SELECT id FROM ids WHERE k = _k $$;
INSERT INTO auth.users (id, email) VALUES (pg_temp.id('fin'), 'fin@teste');
INSERT INTO user_roles (user_id, role) VALUES (pg_temp.id('fin'), 'financeiro');
SELECT set_config('request.jwt.claims', json_build_object('sub', pg_temp.id('fin'), 'role', 'authenticated')::TEXT, true);

SELECT guardrails_suggest(pg_temp.id('cenario'));
UPDATE guardrail_settings SET cost_cut_pct = 0.1 WHERE scenario_id = pg_temp.id('cenario');
CREATE FUNCTION pg_temp.g() RETURNS TABLE (base NUMERIC, lim NUMERIC) LANGUAGE sql AS $$
  SELECT base_expense, expense_limit FROM guardrails(pg_temp.id('cenario')) WHERE unit_id = pg_temp.id('agencia') $$;
CREATE TEMP TABLE antes AS SELECT * FROM pg_temp.g();

INSERT INTO reference_adjustments (year, unit_id, account_id, amount)
VALUES (2026, pg_temp.id('agencia'), pg_temp.id('conta'), 50000)
ON CONFLICT (year, unit_id, account_id) DO UPDATE SET amount = 50000;
CREATE TEMP TABLE ref_conta AS
  SELECT COALESCE((SELECT SUM(amount) FROM reference_rows_omie(2026) WHERE unit_id = pg_temp.id('agencia')
    AND account_id = pg_temp.id('conta')), 0) AS omie;
SELECT is((SELECT base FROM pg_temp.g()), (SELECT base FROM antes) - (SELECT omie FROM ref_conta) + 50000,
  'O ano base corrigido entra na base na hora');
SELECT is((SELECT lim FROM pg_temp.g()), ((SELECT base FROM antes) - (SELECT omie FROM ref_conta) + 50000) * 0.9,
  'E no limite, com o corte');
SELECT is((SELECT base FROM pg_temp.g()),
  (SELECT SUM(amount) FROM reference_rows(2026) WHERE unit_id = pg_temp.id('agencia') AND kind = 'despesa'),
  'A base é a soma das categorias do ano base');
UPDATE guardrail_units SET expense_limit = 1234 WHERE scenario_id = pg_temp.id('cenario') AND unit_id = pg_temp.id('agencia');
SELECT is((SELECT lim FROM pg_temp.g()), 1234::NUMERIC, 'O limite digitado continua valendo');

-- Empresa do Omie
SELECT omie_store_company('Empresa Teste', ARRAY[2026], '[]', '[]', '[]', '[]', '[]');
SELECT omie_store_company('Empresa Teste', ARRAY[2026], '[]', '[]', '[]', '[]', '[]', '12.345.678/0001-90');
SELECT is((SELECT cnpj FROM omie_companies WHERE name = 'Empresa Teste'), '12345678000190',
  'A empresa que já existia pelo nome recebe o CNPJ');
SELECT omie_store_company('Teste Novo Nome', ARRAY[2026], '[]', '[]', '[]', '[]', '[]', '12345678000190');
SELECT is((SELECT count(*)::INT FROM omie_companies WHERE cnpj = '12345678000190' OR name IN ('Empresa Teste', 'Teste Novo Nome')), 1,
  'Nome trocado no Omie: continua uma empresa só');
SELECT is((SELECT name FROM omie_companies WHERE cnpj = '12345678000190'), 'Teste Novo Nome', 'Com o nome novo');

SELECT * FROM finish();
ROLLBACK;
