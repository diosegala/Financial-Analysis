-- Provisão de 13º e provisão de férias em regras separadas, cada uma com o seu percentual por vínculo,
-- para aparecerem em linhas próprias na Folha. A regra única vira a do 13º; a de férias é nova.
UPDATE public.parameter_definitions
SET key = 'provisao_13', label = 'Provisão de 13º salário',
    description = 'Provisão mensal do 13º sobre a remuneração, por vínculo. Referência: 1/12 (8,33%).'
WHERE key = 'provisao_13_ferias';

UPDATE public.calc_rules SET name = 'Provisão de 13º salário'
WHERE parameter_definition_id = (SELECT id FROM public.parameter_definitions WHERE key = 'provisao_13');

INSERT INTO public.parameter_definitions (key, label, description, value_type, allowed_scopes, min_value, max_value, sort_order)
VALUES ('provisao_ferias', 'Provisão de férias (com 1/3)',
  'Provisão mensal das férias e do terço constitucional sobre a remuneração, por vínculo. Referência: 1/12 + 1/3 de 1/12 (11,11%).',
  'percent', ARRAY['global', 'contract_type'], 0, 1, 71);

INSERT INTO public.calc_rules (name, target_dre_line_id, parameter_definition_id, base_kind, payroll_group,
                               contract_type_ids, account_ids, active, sort_order)
SELECT 'Provisão de férias (com 1/3)', r.target_dre_line_id, d.id, 'salario', 'provisao',
       r.contract_type_ids, r.account_ids, r.active, r.sort_order + 1
FROM public.calc_rules r
JOIN public.parameter_definitions p ON p.id = r.parameter_definition_id AND p.key = 'provisao_13'
CROSS JOIN public.parameter_definitions d
WHERE d.key = 'provisao_ferias';
