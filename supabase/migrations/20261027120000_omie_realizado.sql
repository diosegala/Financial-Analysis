-- Integração de leitura com o Omie: o realizado de 2026 vira base para planejar 2027.
-- O app nunca escreve no Omie. Uma rotina local (scripts/omie-sync.py) lê as 3 empresas, soma as contas a pagar
-- por empresa, mês, categoria e departamento, e grava aqui. As chaves da API ficam fora do banco e do repositório.

CREATE TABLE public.omie_companies (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,                 -- Central de Conteúdo, PW Cupola, MKTIMOB
  active BOOLEAN NOT NULL DEFAULT true,
  last_synced_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Departamentos do Omie (hierarquia em structure, ex.: 001.003.002 está dentro de 001.003).
CREATE TABLE public.omie_departments (
  company_id UUID NOT NULL REFERENCES public.omie_companies(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  structure TEXT NOT NULL,
  PRIMARY KEY (company_id, code)
);

CREATE TABLE public.omie_categories (
  company_id UUID NOT NULL REFERENCES public.omie_companies(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  parent_code TEXT,
  is_expense BOOLEAN NOT NULL DEFAULT false,
  is_revenue BOOLEAN NOT NULL DEFAULT false,
  is_total BOOLEAN NOT NULL DEFAULT false,
  PRIMARY KEY (company_id, code)
);

-- Realizado por empresa, ano, mês (data de emissão do título), categoria e departamento ('' = sem departamento).
-- amount_paid = títulos pagos; amount_open = a vencer ou atrasados (já provisionados no Omie).
CREATE TABLE public.omie_actuals (
  company_id UUID NOT NULL REFERENCES public.omie_companies(id) ON DELETE CASCADE,
  year INT NOT NULL,
  month INT NOT NULL CHECK (month BETWEEN 1 AND 12),
  category_code TEXT NOT NULL,
  department_code TEXT NOT NULL DEFAULT '',
  amount_paid NUMERIC NOT NULL DEFAULT 0,
  amount_open NUMERIC NOT NULL DEFAULT 0,
  synced_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, year, month, category_code, department_code)
);

-- Que unidade do app cada departamento do Omie representa. O departamento herda a unidade do ancestral mais
-- próximo que estiver nesta tabela (Receitas Fixas Agência → Agência). Os nomes são iguais nas 3 empresas.
CREATE TABLE public.omie_department_units (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  department_name TEXT NOT NULL,
  unit_id UUID NOT NULL REFERENCES public.units(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX omie_department_units_name ON public.omie_department_units (lower(department_name));

INSERT INTO public.omie_department_units (department_name, unit_id)
SELECT name, id FROM public.units;
INSERT INTO public.omie_department_units (department_name, unit_id)
SELECT 'Growth (área)', id FROM public.units WHERE name = 'Growth'
ON CONFLICT DO NOTHING;

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['omie_companies', 'omie_departments', 'omie_categories', 'omie_actuals', 'omie_department_units']
  LOOP
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON public.%I TO authenticated', t);
    EXECUTE format('GRANT ALL ON public.%I TO service_role', t);
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY "Financeiro reads %1$s" ON public.%1$I FOR SELECT TO authenticated
      USING (public.has_role(auth.uid(), ''financeiro''))', t);
    EXECUTE format('CREATE POLICY "Financeiro writes %1$s" ON public.%1$I FOR ALL TO authenticated
      USING (public.has_role(auth.uid(), ''financeiro'')) WITH CHECK (public.has_role(auth.uid(), ''financeiro''))', t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['omie_companies', 'omie_department_units']
  LOOP
    EXECUTE format('CREATE TRIGGER audit_%1$s AFTER INSERT OR UPDATE OR DELETE ON public.%1$I
      FOR EACH ROW EXECUTE FUNCTION public.audit_trigger()', t);
    EXECUTE format('CREATE TRIGGER upd_%1$s BEFORE UPDATE ON public.%1$I
      FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column()', t);
  END LOOP;
END $$;

-- Unidade de cada departamento (ancestral mais próximo com vínculo). Departamento sem vínculo fica de fora.
CREATE OR REPLACE VIEW public.omie_department_unit WITH (security_invoker = true) AS
SELECT DISTINCT ON (d.company_id, d.code) d.company_id, d.code AS department_code, m.unit_id
FROM public.omie_departments d
JOIN public.omie_departments anc ON anc.company_id = d.company_id
  AND (d.structure = anc.structure OR d.structure LIKE anc.structure || '.%')
JOIN public.omie_department_units m ON lower(m.department_name) = lower(anc.name)
ORDER BY d.company_id, d.code, length(anc.structure) DESC;

-- Despesas do ano por categoria (nome do Omie) e unidade, com os 12 meses em listas (índice 1 = janeiro), somando
-- as empresas. unit_id nulo = título sem departamento ou de departamento sem unidade: nas contas a pagar quase tudo
-- vem assim, então a unidade é escolhida ao planejar. O financeiro vê tudo; o líder só as unidades dele.
CREATE OR REPLACE FUNCTION public.omie_expense_summary(_year INT)
RETURNS TABLE (category_name TEXT, unit_id UUID, paid NUMERIC[], open NUMERIC[])
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  WITH m AS (
    SELECT c.name, du.unit_id, a.month, SUM(a.amount_paid) AS paid, SUM(a.amount_open) AS open
    FROM public.omie_actuals a
    JOIN public.omie_categories c ON c.company_id = a.company_id AND c.code = a.category_code AND c.is_expense
    LEFT JOIN public.omie_department_unit du ON du.company_id = a.company_id AND du.department_code = a.department_code
    WHERE a.year = _year
    GROUP BY c.name, du.unit_id, a.month
  )
  SELECT g.name, g.unit_id,
    ARRAY(SELECT COALESCE((SELECT m2.paid FROM m m2 WHERE m2.name = g.name AND m2.unit_id IS NOT DISTINCT FROM g.unit_id AND m2.month = k), 0)
          FROM generate_series(1, 12) k),
    ARRAY(SELECT COALESCE((SELECT m2.open FROM m m2 WHERE m2.name = g.name AND m2.unit_id IS NOT DISTINCT FROM g.unit_id AND m2.month = k), 0)
          FROM generate_series(1, 12) k)
  FROM (SELECT DISTINCT m.name, m.unit_id FROM m) g
  WHERE public.has_role(auth.uid(), 'financeiro')
     OR (g.unit_id IS NOT NULL AND public.has_unit(auth.uid(), g.unit_id))
$$;
REVOKE EXECUTE ON FUNCTION public.omie_expense_summary(INT) FROM anon;
