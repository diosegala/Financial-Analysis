-- Folha do ano base corrigida pelo financeiro: vale na base e no limite da folha, e recalcular não apaga o valor.
BEGIN;
SELECT plan(5);

CREATE TEMP TABLE ids (k TEXT PRIMARY KEY, id UUID);
INSERT INTO ids VALUES
  ('fin', gen_random_uuid()),
  ('agencia', (SELECT id FROM units WHERE name = 'Agência')),
  ('cenario', (SELECT s.id FROM scenarios s JOIN budget_versions v ON v.id = s.version_id
               WHERE v.name = 'Orçamento 2027' ORDER BY s.created_at LIMIT 1));
CREATE FUNCTION pg_temp.id(_k TEXT) RETURNS UUID LANGUAGE sql AS $$ SELECT id FROM ids WHERE k = _k $$;
INSERT INTO auth.users (id, email) VALUES (pg_temp.id('fin'), 'fin@teste');
INSERT INTO user_roles (user_id, role) VALUES (pg_temp.id('fin'), 'financeiro');
SELECT set_config('request.jwt.claims', json_build_object('sub', pg_temp.id('fin'), 'role', 'authenticated')::TEXT, true);

SELECT guardrails_suggest(pg_temp.id('cenario'));
UPDATE guardrail_settings SET cost_cut_pct = 0.1 WHERE scenario_id = pg_temp.id('cenario');
UPDATE guardrail_units SET base_payroll = 100000 WHERE scenario_id = pg_temp.id('cenario') AND unit_id = pg_temp.id('agencia');

CREATE FUNCTION pg_temp.g() RETURNS TEXT LANGUAGE sql AS $$
  SELECT row(base_payroll, base_payroll_auto, payroll_limit)::TEXT FROM guardrails(pg_temp.id('cenario'))
  WHERE unit_id = pg_temp.id('agencia') $$;

SELECT is(pg_temp.g(), row(100000, 100000, 90000.0)::TEXT, 'Sem correção: a foto do cálculo');
UPDATE guardrail_units SET base_payroll_typed = 80000 WHERE scenario_id = pg_temp.id('cenario') AND unit_id = pg_temp.id('agencia');
SELECT is(pg_temp.g(), row(80000, 100000, 72000.0)::TEXT, 'Corrigida: vale na base e no limite, na hora');
SELECT guardrails_suggest(pg_temp.id('cenario'));
SELECT is((SELECT base_payroll_typed FROM guardrail_units WHERE scenario_id = pg_temp.id('cenario') AND unit_id = pg_temp.id('agencia')),
  80000::NUMERIC, 'Recalcular não apaga o valor digitado');
SELECT is((SELECT base_payroll FROM guardrails(pg_temp.id('cenario')) WHERE unit_id = pg_temp.id('agencia')), 80000::NUMERIC,
  'E ele continua valendo');
UPDATE guardrail_units SET base_payroll_typed = NULL WHERE scenario_id = pg_temp.id('cenario') AND unit_id = pg_temp.id('agencia');
SELECT is((SELECT base_payroll = base_payroll_auto FROM guardrails(pg_temp.id('cenario')) WHERE unit_id = pg_temp.id('agencia')), true,
  'Apagado: volta à foto');

SELECT * FROM finish();
ROLLBACK;
