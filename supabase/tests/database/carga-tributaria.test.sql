-- Carga tributária única: uma alíquota sobre a receita bruta, na linha de impostos, com valor por unidade quando houver,
-- e no custo variável da unidade.
BEGIN;
SELECT plan(5);

CREATE TEMP TABLE ids (k TEXT PRIMARY KEY, id UUID);
INSERT INTO ids VALUES
  ('agencia', (SELECT id FROM units WHERE name = 'Agência')),
  ('consultoria', (SELECT id FROM units WHERE name = 'Consultoria')),
  ('versao', (SELECT id FROM budget_versions WHERE name = 'Orçamento 2027')),
  ('rec', gen_random_uuid()),
  ('carga', (SELECT id FROM parameter_definitions WHERE key = 'carga_tributaria')),
  ('regra', (SELECT r.id FROM calc_rules r JOIN parameter_definitions d ON d.id = r.parameter_definition_id
             WHERE d.key = 'carga_tributaria'));
CREATE FUNCTION pg_temp.id(_k TEXT) RETURNS UUID LANGUAGE sql AS $$ SELECT id FROM ids WHERE k = _k $$;

SELECT is((SELECT row(r.active, r.base_kind, d.code)::TEXT FROM calc_rules r JOIN dre_lines d ON d.id = r.target_dre_line_id
           WHERE r.id = pg_temp.id('regra')), row(true, 'receita', 'impostos')::TEXT,
  'A regra existe, sobre a receita, na linha de impostos');

-- Só a carga tributária: as outras regras (ISS, comissões) desligadas, como fica na configuração.
UPDATE calc_rules SET active = false WHERE id <> pg_temp.id('regra');
INSERT INTO accounts (id, name, kind, treatment, dre_line_id)
VALUES (pg_temp.id('rec'), 'Receita Carga Teste', 'receita', 'lancavel', (SELECT id FROM dre_lines WHERE code = 'receita_bruta'));
CREATE FUNCTION pg_temp.lanca(_unit TEXT, _amount NUMERIC) RETURNS VOID LANGUAGE sql AS $$
  WITH l AS (INSERT INTO plan_lines (version_id, unit_id, account_id)
    VALUES (pg_temp.id('versao'), pg_temp.id(_unit), pg_temp.id('rec')) RETURNING id)
  INSERT INTO plan_values (line_id, month, amount) SELECT id, 3, _amount FROM l
$$;
SELECT pg_temp.lanca('agencia', 100000);
SELECT pg_temp.lanca('consultoria', 200000);
CREATE FUNCTION pg_temp.imposto(_unit TEXT) RETURNS NUMERIC LANGUAGE sql AS $$
  SELECT COALESCE(SUM(v.amount), 0) FROM dre_leaf_values(pg_temp.id('versao'), NULL) v
  JOIN dre_lines d ON d.id = v.dre_line_id AND d.code = 'impostos'
  WHERE v.unit_id = pg_temp.id(_unit) AND v.month = 3
$$;

SELECT is(pg_temp.imposto('agencia'), 0::NUMERIC, 'Sem valor informado, não calcula nada');

INSERT INTO parameter_values (definition_id, value, valid_from) VALUES (pg_temp.id('carga'), 0.108, '2027-01-01');
SELECT is(pg_temp.imposto('agencia'), 10800::NUMERIC, '10,8% da receita bruta da unidade');

INSERT INTO parameter_values (definition_id, value, valid_from, unit_id)
VALUES (pg_temp.id('carga'), 0.12, '2027-01-01', pg_temp.id('consultoria'));
SELECT is(pg_temp.imposto('consultoria'), 24000::NUMERIC, 'Valor da unidade vale sobre o geral');

SELECT is((SELECT rate FROM variable_rate_parts(pg_temp.id('agencia'), '2027-03-01') WHERE rule_id = pg_temp.id('regra')),
  0.108::NUMERIC, 'Entra no custo variável da unidade');

SELECT * FROM finish();
ROLLBACK;
