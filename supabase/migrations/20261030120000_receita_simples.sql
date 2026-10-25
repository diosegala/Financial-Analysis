-- Lançamento de receita mais simples para o líder: descrição, origem e valores. O tipo de receita fica opcional.

-- validate_plan_line sem a exigência de tipo de receita (o resto igual a 20261024120000_folha_por_pessoa).
CREATE OR REPLACE FUNCTION public.validate_plan_line() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  a public.accounts%ROWTYPE;
  p public.people%ROWTYPE;
BEGIN
  SELECT * INTO a FROM public.accounts WHERE id = NEW.account_id;
  IF a.treatment = 'calculada' THEN
    RAISE EXCEPTION 'A conta "%" é calculada pelo app e não pode ser lançada.', a.name;
  ELSIF a.treatment = 'fora_dre' THEN
    RAISE EXCEPTION 'A conta "%" fica fora da DRE e não pode ser lançada.', a.name;
  END IF;
  IF a.unit_ids IS NOT NULL AND NOT NEW.unit_id = ANY (a.unit_ids) THEN
    RAISE EXCEPTION 'A conta "%" não está disponível para esta unidade.', a.name;
  END IF;
  IF NEW.event_id IS NOT NULL THEN
    IF a.kind = 'folha' THEN
      RAISE EXCEPTION 'Um evento só tem itens de receita e de custo.';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.events e
                   WHERE e.id = NEW.event_id AND e.version_id = NEW.version_id AND e.unit_id = NEW.unit_id) THEN
      RAISE EXCEPTION 'O item precisa estar na mesma unidade e versão do evento.';
    END IF;
  END IF;
  IF NEW.person_id IS NOT NULL THEN
    SELECT * INTO p FROM public.people WHERE id = NEW.person_id;
    IF a.kind <> 'folha' OR NEW.event_id IS NOT NULL THEN
      RAISE EXCEPTION 'A remuneração de uma pessoa é uma linha de folha.';
    END IF;
    IF NOT FOUND OR p.version_id <> NEW.version_id OR p.unit_id <> NEW.unit_id THEN
      RAISE EXCEPTION 'A linha precisa estar na mesma unidade e versão da pessoa.';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

-- Receita sem tipo continua pagando a comissão geral: regra que vale para a maioria dos tipos passa do formato
-- "só estes tipos" para "todos, exceto estes" (que inclui linhas sem tipo e tipos criados depois). Regras de um tipo
-- só (ex.: comissão de parceiros) ficam como estão.
UPDATE public.calc_rules r SET
  exclude_revenue_type_ids = NULLIF(ARRAY(SELECT t.id FROM public.revenue_types t WHERE NOT t.id = ANY (r.revenue_type_ids)), '{}'),
  revenue_type_ids = NULL
WHERE r.revenue_type_ids IS NOT NULL AND r.exclude_revenue_type_ids IS NULL
  AND cardinality(r.revenue_type_ids) * 2 >= (SELECT count(*) FROM public.revenue_types);

-- Reajustes da primeira versão: substituídos pelas linhas de remuneração editáveis (PR #10); tabela vazia.
DROP TABLE public.salary_changes;
