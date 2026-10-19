-- Produtos com preço e prazo: ao lançar um produto na previsão, os valores vêm do cadastro.
-- Os lançamentos guardam uma cópia dos valores (mudar o preço depois não altera o que já foi lançado).

ALTER TABLE public.products
  -- servico: contrato com preço e prazo (Consultoria, Agência) · evento: evento ou treinamento (Educação)
  ADD COLUMN kind TEXT NOT NULL DEFAULT 'servico' CHECK (kind IN ('servico', 'evento')),
  ADD COLUMN price NUMERIC CHECK (price >= 0),
  -- mensal: preço por mês · total: valor do contrato diluído no prazo · unico: cobrado uma vez, no mês de início
  ADD COLUMN price_model TEXT NOT NULL DEFAULT 'mensal' CHECK (price_model IN ('mensal', 'total', 'unico')),
  ADD COLUMN duration_months INT CHECK (duration_months BETWEEN 1 AND 120),
  -- eventos
  ADD COLUMN default_seats NUMERIC CHECK (default_seats >= 0),
  ADD COLUMN cost_per_participant NUMERIC CHECK (cost_per_participant >= 0),
  ADD COLUMN fixed_cost NUMERIC CHECK (fixed_cost >= 0),
  ADD COLUMN revenue_account_id UUID REFERENCES public.accounts(id),
  ADD COLUMN cost_account_id UUID REFERENCES public.accounts(id);

-- Preço por participante nos eventos é sempre por unidade vendida; não há "modelo" a escolher.
ALTER TABLE public.products
  ADD CONSTRAINT products_event_has_no_model CHECK (kind = 'servico' OR price_model = 'mensal');

-- O líder cadastra o cliente novo na hora de lançar (só criar; editar e excluir continuam com o financeiro).
CREATE POLICY "Lider creates clients" ON public.clients FOR INSERT TO authenticated
  WITH CHECK (public.has_role(auth.uid(), 'lider'));

-- O mesmo nome pode existir em unidades diferentes; dentro da unidade (ou entre os produtos de todas as
-- unidades) continua único, sem diferenciar maiúsculas.
ALTER TABLE public.products DROP CONSTRAINT products_name_key;
CREATE UNIQUE INDEX products_unit_name_unique
  ON public.products (COALESCE(unit_id, '00000000-0000-0000-0000-000000000000'::uuid), lower(name));
