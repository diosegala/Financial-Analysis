-- Categoria do Omie = conta do app (docs/mudancas-reuniao-fabio-22-10.md, objetivo 2).
-- Sem plano de contas separado: cada conta é uma categoria do Omie, com grupo e período para comparar edições
-- (ex.: "CUPOLA Summit Ingressos - 2026" × "- 2027"), e com uma marcação do que o app calcula ou do que fica fora da DRE.
-- A planilha de categorias não tem código nem departamento: o vínculo continua sendo pelo nome (único) e
-- omie_category_code fica vazio até a integração.

ALTER TABLE public.accounts
  ADD COLUMN group_name TEXT,
  ADD COLUMN period TEXT,
  ADD COLUMN base_name TEXT,
  -- lancavel: aparece nas grades · calculada: o app calcula (impostos, INSS, FGTS…), não se lança
  -- fora_dre: transferências, dividendos, empréstimos, cotas, adiantamento de clientes
  ADD COLUMN treatment TEXT NOT NULL DEFAULT 'lancavel' CHECK (treatment IN ('lancavel', 'calculada', 'fora_dre'));

UPDATE public.accounts SET base_name = name WHERE base_name IS NULL;

ALTER TABLE public.accounts ALTER COLUMN dre_line_id DROP NOT NULL;
ALTER TABLE public.accounts
  ADD CONSTRAINT accounts_dre_line_required CHECK (treatment = 'fora_dre' OR dre_line_id IS NOT NULL);
CREATE INDEX accounts_group_base ON public.accounts (group_name, base_name);

-- Palavras do nome da categoria que apontam para uma unidade, quando o departamento do Omie vier vazio.
-- (units.omie_department_code já existe.)
ALTER TABLE public.units ADD COLUMN name_keywords TEXT[];

-- Regras da importação: tudo dado editável, nada fixo no código. A palavra vale como palavra inteira ou frase.
CREATE TABLE public.account_treatment_rules (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  keyword TEXT NOT NULL,
  treatment TEXT NOT NULL CHECK (treatment IN ('calculada', 'fora_dre')),
  note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX account_treatment_rules_keyword ON public.account_treatment_rules (lower(keyword));

CREATE TABLE public.account_group_rules (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  keyword TEXT NOT NULL,
  group_name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX account_group_rules_keyword ON public.account_group_rules (lower(keyword));

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['account_treatment_rules', 'account_group_rules']
  LOOP
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON public.%I TO authenticated', t);
    EXECUTE format('GRANT ALL ON public.%I TO service_role', t);
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY "Authenticated read %1$s" ON public.%1$I FOR SELECT TO authenticated USING (true)', t);
    EXECUTE format('CREATE POLICY "Financeiro writes %1$s" ON public.%1$I FOR ALL TO authenticated
      USING (public.has_role(auth.uid(), ''financeiro'')) WITH CHECK (public.has_role(auth.uid(), ''financeiro''))', t);
    EXECUTE format('CREATE TRIGGER audit_%1$s AFTER INSERT OR UPDATE OR DELETE ON public.%1$I
      FOR EACH ROW EXECUTE FUNCTION public.audit_trigger()', t);
    EXECUTE format('CREATE TRIGGER upd_%1$s BEFORE UPDATE ON public.%1$I
      FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column()', t);
  END LOOP;
END $$;

-- Valores iniciais, todos editáveis em Configurações. Só o que a reunião de 22/10 citou.
-- "cotas" ficou de fora de propósito: pode ser cota de sócio (fora da DRE) ou cota de patrocínio (receita).
INSERT INTO public.account_treatment_rules (keyword, treatment, note) VALUES
  ('INSS', 'calculada', 'O app calcula'),
  ('FGTS', 'calculada', 'O app calcula'),
  ('ISS', 'calculada', 'O app calcula'),
  ('PIS', 'calculada', 'O app calcula'),
  ('COFINS', 'calculada', 'O app calcula'),
  ('IRPJ', 'calculada', 'O app calcula'),
  ('CSLL', 'calculada', 'O app calcula'),
  ('Simples', 'calculada', 'O app calcula'),
  ('Transferência', 'fora_dre', 'Fora da DRE'),
  ('Dividendos', 'fora_dre', 'Fora da DRE'),
  ('Empréstimo', 'fora_dre', 'Fora da DRE'),
  ('Adiantamento de cliente', 'fora_dre', 'Fora da DRE');

INSERT INTO public.account_group_rules (keyword, group_name) VALUES
  ('Summit', 'Summit'),
  ('Insider Aluguel', 'Insider Aluguel');

-- Só conta lançável entra numa grade. Vale no banco, não só na tela.
CREATE OR REPLACE FUNCTION public.validate_plan_line() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  a public.accounts%ROWTYPE;
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
  IF a.kind = 'receita' AND NEW.revenue_type_id IS NULL THEN
    RAISE EXCEPTION 'Linhas de receita precisam de um tipo de receita.';
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
  RETURN NEW;
END;
$$;

-- Contas em uso (linhas, vínculos, produtos e regras): não se arquiva nem se troca o tratamento sem olhar.
-- Só o financeiro enxerga o resultado; os demais recebem vazio.
CREATE OR REPLACE FUNCTION public.accounts_in_use() RETURNS SETOF UUID
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT DISTINCT id FROM (
    SELECT account_id AS id FROM public.plan_lines
    UNION ALL SELECT account_id FROM public.contract_types
    UNION ALL SELECT revenue_account_id FROM public.products WHERE revenue_account_id IS NOT NULL
    UNION ALL SELECT cost_account_id FROM public.products WHERE cost_account_id IS NOT NULL
    UNION ALL SELECT unnest(account_ids) FROM public.calc_rules WHERE account_ids IS NOT NULL
  ) used
  WHERE public.has_role(auth.uid(), 'financeiro')
$$;
REVOKE EXECUTE ON FUNCTION public.accounts_in_use() FROM anon;
