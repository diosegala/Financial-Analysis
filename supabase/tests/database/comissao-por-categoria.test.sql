-- Percentual por categoria de receita: na Agência a receita fixa e a variável pagam comissões diferentes, sem produto.
BEGIN;
SELECT plan(5);

CREATE TEMP TABLE ids (k TEXT PRIMARY KEY, id UUID);
INSERT INTO ids VALUES
  ('fin', gen_random_uuid()),
  ('agencia', (SELECT id FROM units WHERE name = 'Agência')),
  ('versao', (SELECT id FROM budget_versions WHERE name = 'Orçamento 2027')),
  ('comissao', (SELECT id FROM parameter_definitions WHERE key = 'comissao_comercial')),
  ('linha', (SELECT id FROM dre_lines WHERE code = 'comissionamento'));
INSERT INTO ids SELECT 'conta' || row_number() OVER (ORDER BY a.name), a.id
FROM (SELECT * FROM accounts a WHERE a.kind = 'receita' AND a.treatment = 'lancavel' AND a.active
        AND (a.unit_ids IS NULL OR (SELECT id FROM units WHERE name = 'Agência') = ANY (a.unit_ids))
      ORDER BY a.name LIMIT 2) a;
CREATE FUNCTION pg_temp.id(_k TEXT) RETURNS UUID LANGUAGE sql AS $$ SELECT id FROM ids WHERE k = _k $$;
INSERT INTO auth.users (id, email) VALUES (pg_temp.id('fin'), 'fin@teste');
INSERT INTO user_roles (user_id, role) VALUES (pg_temp.id('fin'), 'financeiro');
SELECT set_config('request.jwt.claims', json_build_object('sub', pg_temp.id('fin'), 'role', 'authenticated')::TEXT, true);

DELETE FROM parameter_values WHERE definition_id = pg_temp.id('comissao');
UPDATE parameter_definitions SET allowed_scopes = ARRAY['global', 'unit', 'account'] WHERE id = pg_temp.id('comissao');

-- Uma linha de 120 mil em cada categoria, 10 mil por mês.
WITH l AS (
  INSERT INTO plan_lines (version_id, unit_id, account_id, description)
  SELECT pg_temp.id('versao'), pg_temp.id('agencia'), pg_temp.id(k), 'teste comissão' FROM (VALUES ('conta1'), ('conta2')) c(k)
  RETURNING id)
INSERT INTO plan_values (line_id, month, amount) SELECT l.id, m, 10000 FROM l CROSS JOIN generate_series(1, 12) m;

CREATE FUNCTION pg_temp.comissao() RETURNS NUMERIC LANGUAGE sql AS $$
  SELECT COALESCE(SUM(amount), 0) FROM dre_leaf_values(pg_temp.id('versao'), NULL, ARRAY[pg_temp.id('agencia')])
  WHERE dre_line_id = pg_temp.id('linha') $$;
CREATE FUNCTION pg_temp.taxa() RETURNS NUMERIC LANGUAGE sql AS $$
  SELECT rate FROM variable_rate_parts(pg_temp.id('agencia'), '2027-06-01') p
  JOIN calc_rules r ON r.id = p.rule_id WHERE r.parameter_definition_id = pg_temp.id('comissao') $$;

INSERT INTO parameter_values (definition_id, value, valid_from) VALUES (pg_temp.id('comissao'), 0.01, '2027-01-01');
CREATE FUNCTION pg_temp.variavel() RETURNS NUMERIC LANGUAGE sql AS $$
  SELECT COALESCE(SUM(amount), 0) FROM plan_split(pg_temp.id('versao'), NULL)
  WHERE unit_id = pg_temp.id('agencia') AND bucket = 'variavel' $$;
CREATE TEMP TABLE geral AS SELECT pg_temp.comissao() AS c, pg_temp.variavel() AS v;
SELECT is(pg_temp.taxa(), 0.01::NUMERIC, 'Só o valor geral: a taxa da unidade é ele');

INSERT INTO parameter_values (definition_id, value, valid_from, account_id)
VALUES (pg_temp.id('comissao'), 0.03, '2027-01-01', pg_temp.id('conta2'));
SELECT is(round(pg_temp.comissao() - (SELECT c FROM geral), 2), 2400.00,
  'A categoria com valor próprio paga 3% (2 pontos a mais sobre 120 mil)');
SELECT is(round(pg_temp.variavel() - (SELECT v FROM geral), 2), 2400.00, 'E entra no custo variável do plano');
SELECT is(round(pg_temp.taxa(), 6), round((
  SELECT SUM(x.amount * COALESCE(param_value(pg_temp.id('comissao'), '2027-06-01', pg_temp.id('agencia'), NULL, NULL, NULL, x.account_id), 0))
         / SUM(x.amount)
  FROM (SELECT l.account_id, SUM(v.amount) AS amount FROM plan_lines l JOIN plan_values v ON v.line_id = l.id
        JOIN accounts a ON a.id = l.account_id
        WHERE l.version_id = pg_temp.id('versao') AND l.unit_id = pg_temp.id('agencia') AND a.kind = 'receita'
          AND COALESCE(l.origin, '') NOT IN ('planilha', 'planilha_deducao')
        GROUP BY l.account_id HAVING SUM(v.amount) > 0) x), 6),
  'A taxa da unidade é a média das categorias, pesada pela receita planejada');
SELECT is(param_value(pg_temp.id('comissao'), '2027-06-01', pg_temp.id('agencia'), NULL, NULL, NULL), 0.01::NUMERIC,
  'Sem categoria, o valor geral (chamada antiga, com 6 argumentos)');

SELECT * FROM finish();
ROLLBACK;
