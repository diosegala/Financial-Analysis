-- Metas de cima para baixo: receita necessária, distribuição por unidade e mês, publicação e acesso.
BEGIN;
SELECT plan(23);

CREATE TEMP TABLE ids (k TEXT PRIMARY KEY, id UUID);
GRANT SELECT ON ids TO authenticated;
INSERT INTO ids VALUES
  ('fin', gen_random_uuid()), ('lid', gen_random_uuid()),
  ('consultoria', (SELECT id FROM units WHERE name = 'Consultoria')),
  ('agencia', (SELECT id FROM units WHERE name = 'Agência')),
  ('financeiro', (SELECT id FROM units WHERE name = 'Financeiro')),
  ('versao', (SELECT id FROM budget_versions WHERE name = 'Orçamento 2027')),
  ('realista', (SELECT id FROM scenarios WHERE name = 'Realista'));
CREATE FUNCTION pg_temp.id(_k TEXT) RETURNS UUID LANGUAGE sql AS $$ SELECT id FROM ids WHERE k = _k $$;
CREATE FUNCTION pg_temp.acc(_n TEXT) RETURNS UUID LANGUAGE sql AS $$ SELECT id FROM accounts WHERE name = _n $$;
CREATE FUNCTION pg_temp.rt(_n TEXT) RETURNS UUID LANGUAGE sql AS $$ SELECT id FROM revenue_types WHERE name = _n $$;
CREATE FUNCTION pg_temp.pd(_k TEXT) RETURNS UUID LANGUAGE sql AS $$ SELECT id FROM parameter_definitions WHERE key = _k $$;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA pg_temp TO authenticated;
INSERT INTO auth.users (id, email) VALUES (pg_temp.id('fin'), 'fin@teste'), (pg_temp.id('lid'), 'lid@teste');
INSERT INTO user_roles (user_id, role) VALUES (pg_temp.id('fin'), 'financeiro'), (pg_temp.id('lid'), 'lider');
INSERT INTO user_units (user_id, unit_id) VALUES (pg_temp.id('lid'), pg_temp.id('consultoria'));
CREATE FUNCTION pg_temp.login(_k TEXT) RETURNS VOID LANGUAGE sql AS $$
  SELECT set_config('request.jwt.claims', json_build_object('sub', pg_temp.id(_k), 'role', 'authenticated')::TEXT, true);
  SET LOCAL ROLE authenticated;
$$;

-- Alíquotas sobre a receita: PIS 1,65% + COFINS 7,6% + ISS 5% + comissão comercial 10% = 24,25%.
-- A comissão de parceiros vale para um só tipo de receita e fica fora da alíquota da meta.
INSERT INTO parameter_values (definition_id, value, valid_from) VALUES
  (pg_temp.pd('pis'), 0.0165, '2027-01-01'), (pg_temp.pd('cofins'), 0.076, '2027-01-01'),
  (pg_temp.pd('iss'), 0.05, '2027-01-01'), (pg_temp.pd('comissao_comercial'), 0.10, '2027-01-01'),
  (pg_temp.pd('comissao_parceiro'), 0.20, '2027-01-01');
-- Custos que não dependem da receita: 12.000 na Consultoria + 6.000 no Financeiro (apoio) = 18.000
WITH l AS (
  INSERT INTO plan_lines (version_id, unit_id, account_id, description) VALUES
    (pg_temp.id('versao'), pg_temp.id('consultoria'), pg_temp.acc('Aluguel e condomínio'), 'a'),
    (pg_temp.id('versao'), pg_temp.id('financeiro'), pg_temp.acc('Aluguel e condomínio'), 'b')
  RETURNING id, description
)
INSERT INTO plan_values (line_id, month, amount) SELECT id, 1, CASE description WHEN 'a' THEN 12000 ELSE 6000 END FROM l;

SELECT pg_temp.login('fin');
INSERT INTO scenario_targets (scenario_id, target_kind, target_value) VALUES (pg_temp.id('realista'), 'resultado', 100000);

SELECT is((SELECT round(sum(rate), 4) FROM variable_rate_parts(pg_temp.id('consultoria'), '2027-03-01') WHERE included),
  0.2425, 'Alíquota variável: 1,65 + 7,6 + 5 + 10 por cento');
SELECT is((SELECT count(*)::INT FROM variable_rate_parts(pg_temp.id('consultoria'), '2027-03-01') WHERE NOT included), 1,
  'Comissão de parceiros fica fora da alíquota');

SELECT throws_ok($$ SELECT compute_targets(pg_temp.id('realista')) $$, 'P0001',
  'As participações das unidades de negócio somam 0.00 por cento, e precisam somar 100.', 'Sem participações, não calcula');

INSERT INTO target_unit_shares (scenario_id, unit_id, share) VALUES
  (pg_temp.id('realista'), pg_temp.id('consultoria'), 0.6), (pg_temp.id('realista'), pg_temp.id('agencia'), 0.4);

-- Alvo de 100.000: R = (100.000 + 18.000) / (1 − 0,2425) = 155.775,5776
SELECT is((SELECT round(required_revenue, 2) FROM compute_targets(pg_temp.id('realista'))), 155775.58, 'Receita necessária para o alvo em R$');
SELECT is((SELECT round(fixed_costs, 2) FROM scenario_targets), 18000.00, 'Custos que não dependem da receita, de todas as unidades');
SELECT is((SELECT round(variable_pct, 4) FROM scenario_targets), 0.2425, 'Alíquota variável ponderada pelas unidades');
SELECT is((SELECT round(target_margin, 4) FROM scenario_targets), round(100000 / 155775.5776, 4), 'Margem equivalente ao alvo em R$');
SELECT is((SELECT round(amount, 2) FROM revenue_targets WHERE unit_id = pg_temp.id('consultoria') AND month = 1), 7788.78,
  'Meta de janeiro da Consultoria: 60% da receita, 1/12');
SELECT is((SELECT round(sum(amount), 2) FROM revenue_targets), 155775.58, 'A distribuição soma a receita necessária');

-- Detalhe guardado para a tela explicar o cálculo
SELECT is((SELECT (breakdown ->> 'expenses')::NUMERIC FROM scenario_targets), 18000::NUMERIC, 'Detalhe: despesas que entram nos custos');
SELECT is((SELECT jsonb_array_length(breakdown -> 'units') FROM scenario_targets), 2, 'Detalhe: uma entrada por unidade de negócio');
SELECT is((SELECT round((u ->> 'variable_pct')::NUMERIC, 4) FROM scenario_targets, jsonb_array_elements(breakdown -> 'units') u
           WHERE (u ->> 'unit_id')::UUID = pg_temp.id('consultoria')), 0.2425, 'Detalhe: alíquota variável da unidade');

-- Pesos dos meses: janeiro 1 e fevereiro 3 (25% e 75%) só para a Consultoria
INSERT INTO target_month_weights (scenario_id, unit_id, month, weight) VALUES
  (pg_temp.id('realista'), pg_temp.id('consultoria'), 1, 1), (pg_temp.id('realista'), pg_temp.id('consultoria'), 2, 3);
SELECT compute_targets(pg_temp.id('realista'));
SELECT is((SELECT round(amount, 2) FROM revenue_targets WHERE unit_id = pg_temp.id('consultoria') AND month = 2), round(155775.5776 * 0.6 * 0.75, 2),
  'Sazonalidade manual: fevereiro com 75% do peso');
SELECT is((SELECT round(amount, 2) FROM revenue_targets WHERE unit_id = pg_temp.id('agencia') AND month = 2), round(155775.5776 * 0.4 / 12, 2),
  'A outra unidade segue o padrão de 12 meses iguais');

-- Receita das áreas de apoio (ex.: financeira) abate da necessária: 10.000 sem alíquota própria
WITH l AS (
  INSERT INTO plan_lines (version_id, unit_id, account_id, revenue_type_id, description)
  VALUES (pg_temp.id('versao'), pg_temp.id('financeiro'), pg_temp.acc('Receita de serviços'), pg_temp.rt('Recorrente 6 meses'), 'fin') RETURNING id
)
INSERT INTO plan_values (line_id, month, amount) SELECT id, 1, 10000 FROM l;
SELECT is((SELECT round(required_revenue, 2) FROM compute_targets(pg_temp.id('realista'))), 142574.26,
  'Receita de apoio de 10.000 reduz a necessária: (100.000 + 18.000 − 10.000) / 0,7575');

-- Alvo em margem de 10%: R = (18.000 − 10.000 × (1 − 0 − 0,1)) / (1 − 0,2425 − 0,1) = 9.000 / 0,6575
UPDATE scenario_targets SET target_kind = 'margem', target_value = 0.10;
SELECT is((SELECT round(required_revenue, 2) FROM compute_targets(pg_temp.id('realista'))), 13688.21, 'Receita necessária para o alvo em margem');
SELECT is((SELECT round(target_amount, 2) FROM scenario_targets), round(0.1 * (9000 / 0.6575 + 10000), 2), 'Alvo em R$ equivalente à margem');
UPDATE scenario_targets SET target_value = 0.80;
SELECT is((SELECT feasible FROM compute_targets(pg_temp.id('realista'))), false, 'Margem que não cabe depois dos variáveis é inviável');
SELECT is((SELECT count(*)::INT FROM revenue_targets), 0, 'Meta inviável não distribui nada');
UPDATE scenario_targets SET target_kind = 'resultado', target_value = 100000;
SELECT compute_targets(pg_temp.id('realista'));

-- Caminho para o alvo: receita 10.000, variável 2.425, despesas 18.000
SELECT is((SELECT round(gap, 2) FROM target_gap(pg_temp.id('realista'))), 110425.00,
  'Falta para o alvo: 100.000 − (10.000 − 2.425 − 18.000)');

-- ───────────── Publicação e acesso do líder ─────────────
SELECT pg_temp.login('lid');
SELECT is((SELECT count(*)::INT FROM revenue_targets), 0, 'Líder não vê a meta antes de publicada');
SELECT pg_temp.login('fin');
SELECT publish_targets(pg_temp.id('realista'));
SELECT throws_ok($$ SELECT compute_targets(pg_temp.id('realista')) $$, 'P0001',
  'A meta deste cenário está publicada. Reabra a meta para recalcular.', 'Meta publicada não recalcula sem reabrir');
SELECT pg_temp.login('lid');
SELECT is((SELECT count(DISTINCT unit_id)::INT FROM revenue_targets), 1, 'Líder vê só a meta da própria unidade depois de publicada');
SELECT * FROM finish();
ROLLBACK;
