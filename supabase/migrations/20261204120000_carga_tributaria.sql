-- Carga tributária única sobre a receita: uma alíquota que soma ISS, IRPJ, CSLL e INSS patronal, sobre a receita bruta
-- de cada unidade, na linha "Impostos sobre a receita". Não inclui o INSS dos segurados nem o IBS/CBS (repassado ao
-- cliente). Entra sem valor: o financeiro informa em Parâmetros. Desligar as regras e linhas que ela substitui (ISS,
-- INSS patronal da folha, IRPJ/CSLL pelo lucro real) é configuração, feita em Configurações.

INSERT INTO public.parameter_definitions (key, label, description, value_type, allowed_scopes, min_value, max_value, sort_order)
VALUES ('carga_tributaria', 'Carga tributária sobre a receita',
  'ISS, IRPJ, CSLL e INSS patronal juntos, sobre a receita bruta. Não inclui o INSS dos segurados nem o IBS/CBS.',
  'percent', ARRAY['global', 'unit'], 0, 1, 5)
ON CONFLICT (key) DO NOTHING;

INSERT INTO public.calc_rules (name, target_dre_line_id, parameter_definition_id, base_kind, active, sort_order)
SELECT 'Carga tributária (ISS, IRPJ, CSLL e INSS patronal)', d.id, pd.id, 'receita', true, 5
FROM public.dre_lines d, public.parameter_definitions pd
WHERE d.code = 'impostos' AND pd.key = 'carga_tributaria'
  AND NOT EXISTS (SELECT 1 FROM public.calc_rules r WHERE r.parameter_definition_id = pd.id);
