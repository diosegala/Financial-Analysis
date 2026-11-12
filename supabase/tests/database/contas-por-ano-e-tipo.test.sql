-- Categorias do Omie viram uma conta por nome, tipo e ano.
BEGIN;
SELECT plan(7);

SELECT is(category_period('Evento Teste - 2027'), '2027', 'Ano no fim do nome');
SELECT is(category_period('Evento Teste 2026/ 27'), '2026/2027', 'Período com o segundo ano curto');
SELECT is(category_period('Evento Teste - 2ª Edição'), NULL, 'Sem ano');

-- Já existem as contas de 2026 do evento e a despesa do outro evento.
INSERT INTO accounts (name, kind, treatment, base_name, period, dre_line_id)
SELECT n, k, 'lancavel', category_base_name(n), category_period(n), (SELECT id FROM dre_lines WHERE name = 'Receita bruta')
FROM (VALUES ('Evento Teste Ingressos - 2026', 'receita'), ('Evento Teste - 2026', 'despesa'),
             ('Outro Evento Teste - 2027', 'despesa')) v(n, k);
WITH c AS (INSERT INTO omie_companies (name) VALUES ('Empresa Teste') RETURNING id)
INSERT INTO omie_categories (company_id, code, name, is_expense, is_revenue)
SELECT c.id, v.code, v.name, v.desp, NOT v.desp FROM c, (VALUES
  ('1.01', 'Evento Teste Ingressos - 2026', false), ('1.02', 'Evento Teste Ingressos - 2027', false),
  ('2.01', 'Evento Teste - 2026', true), ('2.02', 'Evento Teste - 2027', true),
  ('2.03', 'Outro Evento Teste - 2027', true), ('1.03', 'Outro Evento Teste - 2027', false)) v(code, name, desp);

CREATE TEMP TABLE novas AS SELECT unnest(omie_create_new_accounts()) AS name;
SELECT is((SELECT array_agg(name ORDER BY name) FROM novas),
  ARRAY['Evento Teste - 2027', 'Evento Teste Ingressos - 2027', 'Outro Evento Teste - 2027'],
  'A de 2027 vira conta mesmo com a de 2026, e a receita com o nome de uma despesa também');
SELECT is((SELECT kind FROM accounts WHERE name = 'Outro Evento Teste - 2027' AND id NOT IN
           (SELECT id FROM accounts WHERE kind = 'despesa')), 'receita', 'A conta nova é de receita');
SELECT is((SELECT period FROM accounts WHERE name = 'Evento Teste Ingressos - 2027'), '2027', 'A conta nova leva o ano');
SELECT is(cardinality(omie_create_new_accounts()), 0, 'Na leitura seguinte, nada é criado de novo');

SELECT * FROM finish();
ROLLBACK;
