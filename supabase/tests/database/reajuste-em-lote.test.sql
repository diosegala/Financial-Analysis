-- Reajuste em lote: valores, encargos, quem fica de fora, base do limite e permissões.
BEGIN;
SELECT plan(14);

CREATE TEMP TABLE ids (k TEXT PRIMARY KEY, id UUID);
GRANT SELECT ON ids TO authenticated;
INSERT INTO ids VALUES
  ('fin', gen_random_uuid()), ('lider', gen_random_uuid()),
  ('consultoria', (SELECT id FROM units WHERE name = 'Consultoria')),
  ('versao', (SELECT id FROM budget_versions WHERE name = 'Orçamento 2027'));
CREATE FUNCTION pg_temp.id(_k TEXT) RETURNS UUID LANGUAGE sql AS $$ SELECT id FROM ids WHERE k = _k $$;
CREATE FUNCTION pg_temp.ct(_n TEXT) RETURNS UUID LANGUAGE sql AS $$ SELECT id FROM contract_types WHERE name = _n $$;
INSERT INTO auth.users (id, email) VALUES (pg_temp.id('fin'), 'fin@teste'), (pg_temp.id('lider'), 'lider@teste');
INSERT INTO user_roles (user_id, role) VALUES (pg_temp.id('fin'), 'financeiro');
CREATE FUNCTION pg_temp.login(_k TEXT) RETURNS VOID LANGUAGE sql AS $$
  SELECT set_config('request.jwt.claims', json_build_object('sub', pg_temp.id(_k), 'role', 'authenticated')::TEXT, true);
$$;
CREATE FUNCTION pg_temp.valor(_nome TEXT, _mes INT) RETURNS NUMERIC LANGUAGE sql AS $$
  SELECT v.amount FROM plan_values v JOIN plan_lines l ON l.id = v.line_id JOIN people p ON p.id = l.person_id
  WHERE p.name = _nome AND v.month = _mes
$$;
CREATE FUNCTION pg_temp.det(_item TEXT, _mes INT) RETURNS NUMERIC LANGUAGE sql AS $$
  SELECT COALESCE(SUM(amount), 0) FROM payroll_detail(pg_temp.id('versao')) WHERE item = _item AND month = _mes
    AND person_id = (SELECT id FROM people WHERE name = 'Ana')
$$;
CREATE FUNCTION pg_temp.folha() RETURNS NUMERIC LANGUAGE sql AS $$
  SELECT SUM(x.amount) FROM scenarios s CROSS JOIN LATERAL plan_split(pg_temp.id('versao'), s.id) x
  WHERE s.version_id = pg_temp.id('versao') AND x.unit_id = pg_temp.id('consultoria') AND x.bucket = 'folha' AND s.is_official
$$;
CREATE FUNCTION pg_temp.situacao(_nome TEXT, _pct NUMERIC) RETURNS TEXT LANGUAGE sql AS $$
  SELECT situation FROM payroll_bulk_adjust(pg_temp.id('versao'), 7, _pct) WHERE person_name = _nome
$$;
SELECT pg_temp.login('fin');

INSERT INTO people (version_id, unit_id, name, contract_type_id, base_salary) VALUES
  (pg_temp.id('versao'), pg_temp.id('consultoria'), 'Ana', pg_temp.ct('CLT'), 5000),
  (pg_temp.id('versao'), pg_temp.id('consultoria'), 'Bia', pg_temp.ct('CLT'), 5000),
  (pg_temp.id('versao'), pg_temp.id('consultoria'), 'Caio', pg_temp.ct('Sócio (pró-labore)'), 8000),
  (pg_temp.id('versao'), pg_temp.id('consultoria'), 'Duda', pg_temp.ct('CLT'), 3000);
-- Bia já recebeu o reajuste; Duda saiu em junho.
UPDATE plan_values SET amount = 5300 WHERE month >= 7
  AND line_id = (SELECT id FROM plan_lines WHERE person_id = (SELECT id FROM people WHERE name = 'Bia'));
UPDATE plan_values SET amount = 0 WHERE month >= 7
  AND line_id = (SELECT id FROM plan_lines WHERE person_id = (SELECT id FROM people WHERE name = 'Duda'));

SELECT guardrails_suggest((SELECT id FROM scenarios WHERE version_id = pg_temp.id('versao') AND is_official));
CREATE TEMP TABLE antes AS SELECT
  (SELECT base_payroll FROM guardrail_units g JOIN scenarios s ON s.id = g.scenario_id
   WHERE s.is_official AND s.version_id = pg_temp.id('versao') AND g.unit_id = pg_temp.id('consultoria')) AS base,
  pg_temp.folha() AS folha, pg_temp.det('INSS do empregado', 8) AS inss;

-- Simulação não muda nada
SELECT is(pg_temp.situacao('Ana', 0.06), 'reajusta', 'Quem não recebeu entra');
SELECT is(pg_temp.situacao('Bia', 0.06), 'ja_reajustado', 'Quem já mudou de valor no mês fica de fora');
SELECT is(pg_temp.situacao('Duda', 0.06), 'sem_valor', 'Quem saiu antes do mês fica de fora');
SELECT is(pg_temp.valor('Ana', 7), 5000::NUMERIC, 'A simulação não altera os valores');

SELECT lives_ok($$ SELECT * FROM payroll_bulk_adjust(pg_temp.id('versao'), 7, 0.06, true) $$, 'Aplica');
SELECT is(ARRAY[pg_temp.valor('Ana', 6), pg_temp.valor('Ana', 7), pg_temp.valor('Ana', 12)],
  ARRAY[5000, 5300, 5300]::NUMERIC[], 'Só de julho em diante');
SELECT is(pg_temp.valor('Caio', 7), 8480::NUMERIC, 'Vale também para o sócio');
SELECT is(pg_temp.valor('Bia', 7), 5300::NUMERIC, 'Quem já tinha não acumula');
SELECT is(pg_temp.valor('Duda', 7), 0::NUMERIC, 'Quem saiu continua zerado');
SELECT ok(pg_temp.det('INSS do empregado', 8) > (SELECT inss FROM antes), 'O cálculo da folha acompanha o novo valor');
SELECT is(
  (SELECT base_payroll FROM guardrail_units g JOIN scenarios s ON s.id = g.scenario_id
   WHERE s.is_official AND s.version_id = pg_temp.id('versao') AND g.unit_id = pg_temp.id('consultoria')) - (SELECT base FROM antes),
  pg_temp.folha() - (SELECT folha FROM antes), 'A base do limite sobe exatamente o que a folha subiu');
SELECT is(pg_temp.situacao('Ana', 0.06), 'ja_reajustado', 'Repetir o lote não aplica de novo');

UPDATE guardrail_settings SET published_at = now();
SELECT throws_ok($$ SELECT * FROM payroll_bulk_adjust(pg_temp.id('versao'), 8, 0.06, true) $$,
  'O plano está publicado para os diretores. Reabra antes de reajustar em lote.', 'Plano publicado: precisa reabrir');

SELECT pg_temp.login('lider');
SELECT throws_ok($$ SELECT * FROM payroll_bulk_adjust(pg_temp.id('versao'), 7, 0.06) $$,
  'Somente o financeiro reajusta a folha em lote.', 'Diretor não usa');

SELECT * FROM finish();
ROLLBACK;
