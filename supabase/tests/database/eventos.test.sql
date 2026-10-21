-- Eventos com itens (ex.: Cupola Summit): receitas e custos por categoria, comissão sobre patrocínio,
-- cópia de versão e exclusão em cascata.
BEGIN;
SELECT plan(16);

CREATE TEMP TABLE ids (k TEXT PRIMARY KEY, id UUID);
GRANT SELECT ON ids TO authenticated;
INSERT INTO ids VALUES
  ('fin', gen_random_uuid()), ('lid', gen_random_uuid()),
  ('consultoria', (SELECT id FROM units WHERE name = 'Consultoria')),
  ('agencia', (SELECT id FROM units WHERE name = 'Agência')),
  ('versao', (SELECT id FROM budget_versions WHERE name = 'Orçamento 2027')),
  ('realista', (SELECT id FROM scenarios WHERE name = 'Realista'));
CREATE FUNCTION pg_temp.id(_k TEXT) RETURNS UUID LANGUAGE sql AS $$ SELECT id FROM ids WHERE k = _k $$;
CREATE FUNCTION pg_temp.acc(_n TEXT) RETURNS UUID LANGUAGE sql AS $$ SELECT id FROM accounts WHERE name = _n $$;
CREATE FUNCTION pg_temp.rt(_n TEXT) RETURNS UUID LANGUAGE sql AS $$ SELECT id FROM revenue_types WHERE name = _n $$;
CREATE FUNCTION pg_temp.line(_c TEXT) RETURNS UUID LANGUAGE sql AS $$ SELECT id FROM dre_lines WHERE code = _c $$;
CREATE FUNCTION pg_temp.dre(_code TEXT, _month INT) RETURNS NUMERIC LANGUAGE sql AS $$
  SELECT ROUND(amount, 4) FROM dre_report(pg_temp.id('versao'), pg_temp.id('realista'), ARRAY[pg_temp.id('consultoria')])
  WHERE dre_line_id = pg_temp.line(_code) AND month = _month
$$;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA pg_temp TO authenticated;

INSERT INTO auth.users (id, email) VALUES (pg_temp.id('fin'), 'fin@teste'), (pg_temp.id('lid'), 'lid@teste');
INSERT INTO user_roles (user_id, role) VALUES (pg_temp.id('fin'), 'financeiro'), (pg_temp.id('lid'), 'lider');
INSERT INTO user_units (user_id, unit_id) VALUES (pg_temp.id('lid'), pg_temp.id('consultoria'));
INSERT INTO parameter_values (definition_id, value, valid_from)
VALUES ((SELECT id FROM parameter_definitions WHERE key = 'comissao_comercial'), 0.10, '2027-01-01');

CREATE FUNCTION pg_temp.login(_k TEXT) RETURNS VOID LANGUAGE sql AS $$
  SELECT set_config('request.jwt.claims', json_build_object('sub', pg_temp.id(_k), 'role', 'authenticated')::TEXT, true);
  SET LOCAL ROLE authenticated;
$$;

-- ───────────── Financeiro monta o evento ─────────────
SELECT pg_temp.login('fin');
-- Summit: ingressos em dois lotes de meses, patrocínio em 3 parcelas, custo de local em abril.
SELECT lives_ok($$
  SELECT launch_event(pg_temp.id('versao'), pg_temp.id('consultoria'), NULL, 'Summit', 6,
    ('[{"account_id": "' || pg_temp.acc('Receita de educação') || '", "description": "Ingressos lote 1",
        "revenue_type_id": "' || pg_temp.rt('Ingressos') || '", "values": [{"month": 3, "amount": 3000}, {"month": 4, "amount": 7000}]},
       {"account_id": "' || pg_temp.acc('Receita de serviços') || '", "description": "Patrocínio Ouro",
        "revenue_type_id": "' || pg_temp.rt('Patrocínio') || '",
        "values": [{"month": 3, "amount": 10000}, {"month": 4, "amount": 10000}, {"month": 5, "amount": 10000}]},
       {"account_id": "' || pg_temp.acc('Despesas de produtos') || '", "description": "Local",
        "values": [{"month": 4, "amount": 4000}]}]')::JSONB)
$$, 'Evento criado já com itens de receita e de custo');
SELECT is((SELECT count(*)::INT FROM plan_lines WHERE event_id = (SELECT id FROM events WHERE name = 'Summit')), 3,
  'Os três itens ficaram ligados ao evento');
SELECT is(pg_temp.dre('receita_bruta', 3), 13000.0000, 'Março: ingressos 3.000 + patrocínio 10.000');
SELECT is(pg_temp.dre('comissionamento', 3), 1300.0000, 'Comissão incide sobre ingressos e patrocínio');
SELECT is(pg_temp.dre('contribuicao_liquida', 4), 11300.0000, 'Abril: 17.000 de receita − 4.000 de local − 1.700 de comissão');

-- Um tipo de receita criado depois já entra na comissão (regra "todos, exceto Parceiros").
INSERT INTO revenue_types (name) VALUES ('Mentoria');
SELECT lives_ok($$
  SELECT launch_line(pg_temp.id('versao'), pg_temp.id('consultoria'), pg_temp.acc('Receita de serviços'), 'Mentoria avulsa',
    NULL, NULL, pg_temp.rt('Mentoria'), '[{"month": 3, "amount": 1000}]'::JSONB)
$$, 'Linha com tipo de receita novo');
SELECT is(pg_temp.dre('comissionamento', 3), 1400.0000, 'Tipo criado depois também recebe a comissão');
SELECT lives_ok($$
  SELECT launch_line(pg_temp.id('versao'), pg_temp.id('consultoria'), pg_temp.acc('Receita de serviços'), 'Parceiro',
    NULL, NULL, pg_temp.rt('Parceiros'), '[{"month": 3, "amount": 1000}]'::JSONB)
$$, 'Linha do tipo Parceiros');
SELECT is(pg_temp.dre('comissionamento', 3), 1400.0000, 'Parceiros fica fora da comissão comercial');

-- ───────────── Regras dos itens ─────────────
SELECT throws_ok($$
  SELECT launch_line(pg_temp.id('versao'), pg_temp.id('agencia'), pg_temp.acc('Despesas de produtos'), 'Item de outra unidade',
    NULL, NULL, NULL, '[]'::JSONB, (SELECT id FROM events WHERE name = 'Summit'))
$$, 'P0001', NULL, 'Item precisa estar na mesma unidade do evento');
SELECT throws_ok($$
  SELECT launch_line(pg_temp.id('versao'), pg_temp.id('consultoria'), pg_temp.acc('Salários CLT'), 'Folha no evento',
    NULL, NULL, NULL, '[]'::JSONB, (SELECT id FROM events WHERE name = 'Summit'))
$$, 'P0001', NULL, 'Evento não aceita item de folha');
RESET ROLE;

-- ───────────── Líder acrescenta item, mas não edita o evento ─────────────
SELECT pg_temp.login('lid');
SELECT lives_ok($$
  SELECT launch_line(pg_temp.id('versao'), pg_temp.id('consultoria'), pg_temp.acc('Receita de serviços'), 'Patrocínio extra',
    NULL, NULL, pg_temp.rt('Patrocínio'), '[{"month": 5, "amount": 5000}]'::JSONB, (SELECT id FROM events WHERE name = 'Summit'))
$$, 'Líder acrescenta um item ao evento da própria unidade');
UPDATE events SET name = 'Renomeado' WHERE name = 'Summit';
SELECT is((SELECT count(*)::INT FROM events WHERE name = 'Summit'), 1, 'Líder não renomeia o evento');
RESET ROLE;

-- ───────────── Copiar versão e excluir ─────────────
SELECT pg_temp.login('fin');
SELECT lives_ok($$ SELECT copy_version(pg_temp.id('versao'), 'Forecast', 2027, 'forecast') $$, 'Financeiro copia a versão');
SELECT is((SELECT count(*)::INT FROM plan_lines l JOIN events e ON e.id = l.event_id
           WHERE l.version_id = (SELECT id FROM budget_versions WHERE name = 'Forecast') AND e.version_id = l.version_id), 4,
  'Os 4 itens do evento foram copiados ligados ao evento copiado');
DELETE FROM events WHERE name = 'Summit' AND version_id = pg_temp.id('versao');
SELECT is((SELECT count(*)::INT FROM plan_lines WHERE description IN ('Ingressos lote 1', 'Patrocínio Ouro', 'Local', 'Patrocínio extra')
           AND version_id = pg_temp.id('versao')), 0, 'Excluir o evento exclui seus itens');
RESET ROLE;

SELECT * FROM finish();
ROLLBACK;
