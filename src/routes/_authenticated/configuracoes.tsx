import { createFileRoute, Navigate } from "@tanstack/react-router";
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Copy } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { pageHead } from "@/lib/head";
import { useCurrentUser } from "@/lib/auth";
import {
  useAccountGroupRules,
  useAccountTreatmentRules,
  useAccounts,
  useAllScenarios,
  useCalcRules,
  useOmieCategoryAllocations,
  useOmieDepartmentUnits,
  useOmieKeywordUnits,
  usePayrollBrackets,
  usePayrollCalendar,
  usePayrollConstants,
  useClients,
  useContractTypes,
  useDreLines,
  useParameterDefinitions,
  useRevenueTypes,
  useUnits,
  useVersions,
} from "@/lib/catalog";
import { MONTHS_FULL } from "@/lib/format";
import { norm } from "@/lib/products-import";
import { NATURE_OPTIONS } from "@/lib/products";
import { VERSION_STATUS_LABELS } from "@/lib/submissions";
import { PageHeader } from "@/components/page-header";
import { AccountsImport } from "@/components/accounts-import";
import { AppSettingField } from "@/components/app-setting-field";
import { CrudTable, type FieldDef } from "@/components/crud-table";
import { Field, OptionSelect } from "@/components/form-fields";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export const Route = createFileRoute("/_authenticated/configuracoes")({
  head: pageHead(
    "Configurações",
    "Cadastros, estrutura da DRE, plano de contas e regras de cálculo.",
  ),
  component: ConfiguracoesPage,
});

const opts = (rows: { id: string; name: string }[] | undefined) =>
  (rows ?? []).map((r) => ({ value: r.id, label: r.name }));
const active = { key: "active", label: "Ativo", type: "boolean" } as const;
const order = {
  key: "sort_order",
  label: "Ordem",
  type: "number",
  integer: true,
  hideInTable: true,
} as const;
const MONTH_OPTIONS = MONTHS_FULL.map((m, i) => ({ value: String(i + 1), label: m }));

function ConfiguracoesPage() {
  const { data: user, isLoading } = useCurrentUser();
  if (!isLoading && user && !user.isFinanceiro) return <Navigate to="/inicio" />;

  return (
    <div className="space-y-4">
      <PageHeader
        title="Configurações"
        subtitle="Tudo o que alimenta o planejamento é editável aqui."
      />
      <Tabs defaultValue="versoes">
        <TabsList className="flex h-auto flex-wrap justify-start">
          <TabsTrigger value="versoes">Versões</TabsTrigger>
          <TabsTrigger value="unidades">Unidades</TabsTrigger>
          <TabsTrigger value="contas">Plano de contas</TabsTrigger>
          <TabsTrigger value="vinculos">Vínculos</TabsTrigger>
          <TabsTrigger value="tipos">Tipos de receita</TabsTrigger>
          <TabsTrigger value="clientes">Clientes</TabsTrigger>
          <TabsTrigger value="avancado">Avançado</TabsTrigger>
        </TabsList>
        <TabsContent value="versoes">
          <VersionsTab />
        </TabsContent>
        <TabsContent value="unidades">
          <UnitsTab />
        </TabsContent>
        <TabsContent value="contas">
          <AccountsTab />
        </TabsContent>
        <TabsContent value="vinculos">
          <ContractTypesTab />
        </TabsContent>
        <TabsContent value="tipos">
          <RevenueTypesTab />
        </TabsContent>
        <TabsContent value="clientes">
          <ClientsTab />
        </TabsContent>
        <TabsContent value="avancado">
          <AdvancedTab />
        </TabsContent>
      </Tabs>
    </div>
  );
}

/** O que se mexe raramente: estrutura da DRE, cenários, regras de cálculo e da importação, tabelas da folha e Omie. */
function AdvancedTab() {
  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">
        Ajustes que mudam pouco. Impostos, comissões e encargos se cadastram na página Parâmetros.
      </p>
      <Tabs defaultValue="cenarios">
        <TabsList className="flex h-auto flex-wrap justify-start">
          <TabsTrigger value="cenarios">Cenários</TabsTrigger>
          <TabsTrigger value="dre">Estrutura da DRE</TabsTrigger>
          <TabsTrigger value="regras">Regras de cálculo</TabsTrigger>
          <TabsTrigger value="importacao">Regras da importação</TabsTrigger>
          <TabsTrigger value="tabelas-folha">Tabelas da folha</TabsTrigger>
          <TabsTrigger value="omie">Omie</TabsTrigger>
        </TabsList>
        <TabsContent value="cenarios">
          <ScenariosTab />
        </TabsContent>
        <TabsContent value="dre">
          <DreLinesTab />
        </TabsContent>
        <TabsContent value="regras">
          <CalcRulesTab />
        </TabsContent>
        <TabsContent value="importacao">
          <ImportRulesTab />
        </TabsContent>
        <TabsContent value="tabelas-folha">
          <PayrollTablesTab />
        </TabsContent>
        <TabsContent value="omie">
          <OmieTab />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function VersionsTab() {
  const { data: versions } = useVersions();
  const queryClient = useQueryClient();
  const [source, setSource] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [year, setYear] = useState(String(new Date().getFullYear() + 1));

  async function copy() {
    if (!source || !name.trim()) return;
    const { error } = await supabase.rpc("copy_version", {
      _source_id: source,
      _name: name.trim(),
      _year: Number(year),
      _kind: "forecast",
    });
    if (error) {
      toast.error(error.message);
      return;
    }
    toast.success("Versão copiada. Ela começa como rascunho.");
    setName("");
    await queryClient.invalidateQueries();
  }

  const fields: FieldDef[] = [
    { key: "name", label: "Nome", type: "text", required: true },
    { key: "year", label: "Ano", type: "number", integer: true, required: true },
    {
      key: "kind",
      label: "Tipo",
      type: "select",
      required: true,
      options: [
        { value: "orcamento", label: "Orçamento" },
        { value: "forecast", label: "Forecast" },
      ],
    },
    {
      key: "status",
      label: "Status",
      type: "select",
      required: true,
      hint: "Em coleta: líderes lançam. Travado: ninguém altera, nem o financeiro.",
      options: Object.entries(VERSION_STATUS_LABELS).map(([value, label]) => ({ value, label })),
    },
    {
      key: "first_editable_month",
      label: "Primeiro mês editável",
      type: "select",
      required: true,
      hint: "Em forecasts, os meses já realizados ficam bloqueados para os líderes.",
      options: MONTH_OPTIONS,
    },
    {
      key: "is_default",
      label: "Versão padrão",
      type: "boolean",
      hint: "Aberta por padrão para todos.",
    },
  ];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-2 rounded-md border border-border bg-card p-3">
        <Field label="Copiar a versão">
          <OptionSelect
            className="w-52"
            value={source}
            onChange={setSource}
            options={opts(versions)}
          />
        </Field>
        <Field label="Nome da nova versão">
          <Input
            className="w-56"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="ex.: Forecast Abr/27"
          />
        </Field>
        <Field label="Ano">
          <Input
            className="w-20 font-mono"
            value={year}
            onChange={(e) => setYear(e.target.value.replace(/\D/g, "").slice(0, 4))}
          />
        </Field>
        <Button size="sm" className="gap-1.5" onClick={copy} disabled={!source || !name.trim()}>
          <Copy className="h-4 w-4" /> Copiar
        </Button>
      </div>
      <CrudTable
        table="budget_versions"
        rows={versions ?? []}
        fields={fields}
        description="Para criar um forecast ou o orçamento do ano seguinte, copie uma versão: pessoas, eventos, lançamentos e cenários vêm junto."
        defaults={{
          kind: "orcamento",
          status: "rascunho",
          first_editable_month: "1",
          is_default: false,
        }}
        beforeSave={async (draft, row) => {
          draft["first_editable_month"] = Number(draft["first_editable_month"]);
          if (draft["is_default"] && !row?.["is_default"]) {
            await supabase
              .from("budget_versions")
              .update({ is_default: false })
              .eq("is_default", true);
          }
          return true;
        }}
      />
    </div>
  );
}

function ScenariosTab() {
  const { data: scenarios } = useAllScenarios();
  const { data: versions } = useVersions();
  return (
    <CrudTable
      table="scenarios"
      rows={scenarios ?? []}
      description="As variações e o cenário oficial são definidos na página Cenários."
      fields={[
        {
          key: "version_id",
          label: "Versão",
          type: "select",
          required: true,
          options: opts(versions),
        },
        { key: "name", label: "Nome", type: "text", required: true },
        order,
      ]}
      defaults={{ sort_order: 0 }}
    />
  );
}

function UnitsTab() {
  const { data: units } = useUnits();
  return (
    <CrudTable
      table="units"
      rows={units ?? []}
      fields={[
        { key: "name", label: "Nome", type: "text", required: true },
        {
          key: "kind",
          label: "Tipo",
          type: "select",
          required: true,
          options: [
            { value: "negocio", label: "Negócio" },
            { value: "apoio", label: "Apoio" },
          ],
        },
        {
          key: "name_keywords",
          label: "Palavras no nome da categoria",
          type: "tags",
          hint: "Separe por vírgula. Na importação do plano de contas, ajudam a achar a unidade quando o departamento do Omie vem vazio. Ex.: Summit, Insider.",
        },
        active,
        order,
      ]}
      defaults={{ kind: "negocio", active: true, sort_order: 0 }}
    />
  );
}

function DreLinesTab() {
  const { data: lines } = useDreLines();
  return (
    <CrudTable
      table="dre_lines"
      rows={lines ?? []}
      description="Lançada: soma das contas ligadas a ela. Calculada: resultado das regras de cálculo. Subtotal: soma com sinal de todas as linhas lançadas e calculadas acima dela. Percentual: numerador ÷ denominador."
      fields={[
        { key: "name", label: "Nome", type: "text", required: true },
        { key: "code", label: "Código", type: "text", required: true },
        { key: "sort_order", label: "Ordem", type: "number", integer: true, required: true },
        {
          key: "kind",
          label: "Tipo",
          type: "select",
          required: true,
          options: [
            { value: "lancada", label: "Lançada" },
            { value: "calculada", label: "Calculada" },
            { value: "subtotal", label: "Subtotal" },
            { value: "percentual", label: "Percentual" },
          ],
        },
        {
          key: "sign",
          label: "Sinal",
          type: "select",
          required: true,
          hint: "Soma (+) ou subtrai (−) nos subtotais.",
          options: [
            { value: "1", label: "+ Soma" },
            { value: "-1", label: "− Subtrai" },
          ],
        },
        {
          key: "numerator_line_id",
          label: "Numerador",
          type: "select",
          options: opts(lines),
          hideInTable: true,
        },
        {
          key: "denominator_line_id",
          label: "Denominador",
          type: "select",
          options: opts(lines),
          hideInTable: true,
        },
        active,
      ]}
      defaults={{ kind: "lancada", sign: "-1", active: true }}
      beforeSave={(draft) => {
        draft["sign"] = Number(draft["sign"]);
        return true;
      }}
    />
  );
}

function AccountsTab() {
  const { data: accounts } = useAccounts();
  const { data: lines } = useDreLines();
  const { data: units } = useUnits();
  const [search, setSearch] = useState("");
  const [groupFilter, setGroupFilter] = useState<string | null>(null);
  const [treatmentFilter, setTreatmentFilter] = useState<string | null>(null);
  const all = accounts ?? [];
  const groups = [...new Set(all.map((a) => a.group_name).filter((g): g is string => !!g))].sort();
  const rows = all.filter(
    (a) =>
      (!search || norm(a.name).includes(norm(search))) &&
      (!groupFilter || a.group_name === groupFilter) &&
      (!treatmentFilter || a.treatment === treatmentFilter),
  );
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border bg-card p-3">
        <p className="max-w-2xl text-sm text-muted-foreground">
          Já tem o plano de contas no Omie? Importe a lista em vez de cadastrar uma a uma. As contas
          importadas guardam o código do Omie, que depois liga o realizado ao planejado.
        </p>
        <AccountsImport />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Input
          className="w-64"
          placeholder="Buscar conta pelo nome"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          aria-label="Buscar conta"
        />
        <OptionSelect
          className="w-48"
          value={groupFilter}
          onChange={setGroupFilter}
          noneLabel="Todos os grupos"
          options={groups.map((g) => ({ value: g, label: g }))}
        />
        <OptionSelect
          className="w-52"
          value={treatmentFilter}
          onChange={setTreatmentFilter}
          noneLabel="Todos os tratamentos"
          options={[
            { value: "lancavel", label: "Lançável" },
            { value: "calculada", label: "Calculada pelo app" },
            { value: "fora_dre", label: "Fora da DRE" },
          ]}
        />
        <span className="text-sm text-muted-foreground">
          {rows.length} de {all.length} contas
        </span>
      </div>
      <CrudTable
        table="accounts"
        rows={rows}
        description="Cada conta aparece numa grade (Receitas, Despesas ou Folha) e soma numa linha da DRE."
        fields={[
          { key: "name", label: "Nome", type: "text", required: true },
          { key: "code", label: "Código", type: "text", hideInTable: true },
          {
            key: "group_name",
            label: "Grupo",
            type: "text",
            hint: "Ex.: Summit. Junta as edições de um mesmo evento.",
          },
          { key: "period", label: "Período", type: "text", hint: "Ex.: 2027 ou 2026/2027." },
          {
            key: "base_name",
            label: "Nome sem o período",
            type: "text",
            hideInTable: true,
            hint: "Chave do comparativo entre edições.",
          },
          {
            key: "treatment",
            label: "Tratamento",
            type: "select",
            required: true,
            hint: "Lançável aparece nas grades. Calculada pelo app (impostos, INSS…) e fora da DRE não se lançam.",
            options: [
              { value: "lancavel", label: "Lançável" },
              { value: "calculada", label: "Calculada pelo app" },
              { value: "fora_dre", label: "Fora da DRE" },
            ],
          },
          {
            key: "kind",
            label: "Grade",
            type: "select",
            required: true,
            options: [
              { value: "receita", label: "Receitas" },
              { value: "despesa", label: "Despesas" },
              { value: "folha", label: "Folha" },
            ],
          },
          {
            key: "dre_line_id",
            label: "Linha da DRE",
            type: "select",
            noneLabel: "Nenhuma (fora da DRE)",
            hint: "Obrigatória, exceto para contas fora da DRE.",
            options: opts(
              (lines ?? []).filter((l) => l.kind === "lancada" || l.kind === "calculada"),
            ),
          },
          {
            key: "unit_ids",
            label: "Unidades",
            type: "multi",
            options: opts(units),
            emptyLabel: "Todas",
          },
          {
            key: "per_person",
            label: "Benefício por pessoa",
            type: "boolean",
            hideInTable: true,
            hint: "Só para contas de Folha: o valor é lançado por pessoa na Folha (ex.: assistência médica).",
          },
          {
            key: "generates_tax_credit",
            label: "Gera crédito de PIS/COFINS",
            type: "boolean",
            hideInTable: true,
          },
          { key: "omie_category_code", label: "Código no Omie", type: "text", hideInTable: true },
          active,
          order,
        ]}
        defaults={{
          kind: "despesa",
          treatment: "lancavel",
          active: true,
          sort_order: 0,
          generates_tax_credit: false,
          per_person: false,
        }}
      />
    </div>
  );
}

function ImportRulesTab() {
  const { data: treatmentRules } = useAccountTreatmentRules();
  const { data: groupRules } = useAccountGroupRules();
  return (
    <div className="space-y-6">
      <section className="space-y-2">
        <h2 className="text-lg font-semibold">Contas que o app calcula ou que ficam fora da DRE</h2>
        <CrudTable
          table="account_treatment_rules"
          rows={treatmentRules ?? []}
          description="Na importação, a categoria cujo nome tem uma destas palavras vem sugerida como calculada pelo app (impostos, INSS, FGTS…) ou fora da DRE (transferências, dividendos…). Vale como palavra inteira, sem diferenciar acento nem maiúscula. Tudo pode ser corrigido linha a linha na conferência."
          fields={[
            { key: "keyword", label: "Palavra ou frase", type: "text", required: true },
            {
              key: "treatment",
              label: "Tratamento",
              type: "select",
              required: true,
              options: [
                { value: "calculada", label: "Calculada pelo app" },
                { value: "fora_dre", label: "Fora da DRE" },
              ],
            },
            { key: "note", label: "Observação", type: "text" },
          ]}
          defaults={{ treatment: "calculada" }}
        />
      </section>
      <section className="space-y-2">
        <h2 className="text-lg font-semibold">Grupos das categorias</h2>
        <CrudTable
          table="account_group_rules"
          rows={groupRules ?? []}
          description="Na importação, a categoria cujo nome tem a palavra entra no grupo (ex.: Summit). O grupo junta as edições de um mesmo evento para o comparativo."
          fields={[
            { key: "keyword", label: "Palavra ou frase", type: "text", required: true },
            { key: "group_name", label: "Grupo", type: "text", required: true },
          ]}
        />
      </section>
    </div>
  );
}

function RevenueTypesTab() {
  const { data: types } = useRevenueTypes();
  return (
    <CrudTable
      table="revenue_types"
      rows={types ?? []}
      fields={[
        { key: "name", label: "Nome", type: "text", required: true },
        {
          key: "recurrence_months",
          label: "Recorrência (meses)",
          type: "number",
          integer: true,
          hint: "Ao lançar, preenche esta quantidade de meses.",
        },
        {
          key: "max_months",
          label: "Máximo de meses",
          type: "number",
          integer: true,
          hint: "A grade avisa quando a linha passa deste limite.",
        },
        {
          key: "nature",
          label: "Natureza",
          type: "select",
          options: NATURE_OPTIONS,
          hint: "Separa a receita recorrente da variável na DRE e no painel da diretoria.",
        },
        active,
        order,
      ]}
      defaults={{ active: true, sort_order: 0 }}
    />
  );
}

function ContractTypesTab() {
  const { data: types } = useContractTypes();
  const { data: accounts } = useAccounts();
  const { data: calendar } = usePayrollCalendar();
  return (
    <div className="space-y-8">
      <CrudTable
        table="contract_types"
        rows={types ?? []}
        description="Encargos, 13º, terço de férias e benefícios de cada vínculo são informados na página Parâmetros."
        fields={[
          { key: "name", label: "Nome", type: "text", required: true },
          {
            key: "account_id",
            label: "Conta da remuneração",
            type: "select",
            required: true,
            options: opts(
              (accounts ?? []).filter((a) => a.kind === "folha" && a.treatment === "lancavel"),
            ),
          },
          {
            key: "role_keywords",
            label: "Palavras no cargo",
            type: "tags",
            hint: "Separe por vírgula. Na importação da folha, cargos com estas palavras sugerem este vínculo. Ex.: estagio, estagiario.",
          },
          {
            key: "withholds",
            label: "Desconta INSS e IRRF pela tabela",
            type: "boolean",
            hint: "Desligado (ex.: sócios), o salário líquido só desconta o IRRF informado em cada pessoa.",
          },
          active,
          order,
        ]}
        defaults={{ active: true, sort_order: 0, withholds: true }}
      />
      <div className="space-y-2">
        <h2 className="text-lg font-semibold">Calendário do 13º e das férias</h2>
        <CrudTable
          table="payroll_calendar"
          rows={calendar ?? []}
          description="Em que mês a folha paga o 13º e o terço de férias. 13º: cada linha é uma parcela, em fração do 13º do ano (0,5 = metade); as parcelas somam 1, e os descontos e encargos do 13º saem na última. Férias: cada linha é um período, em dias; entra o terço sobre esses dias no mês (o resto é salário adiantado). Quem recebe cada um, por vínculo, fica em Parâmetros (13º salário e Terço de férias)."
          fields={[
            {
              key: "kind",
              label: "Tipo",
              type: "select",
              required: true,
              options: [
                { value: "decimo_terceiro", label: "13º salário" },
                { value: "ferias", label: "Férias" },
              ],
            },
            {
              key: "month",
              label: "Mês",
              type: "select",
              required: true,
              options: MONTH_OPTIONS,
            },
            { key: "share", label: "Parcela do 13º (fração)", type: "number" },
            { key: "days", label: "Dias de férias", type: "number", integer: true },
            { key: "note", label: "Observação", type: "text" },
          ]}
          defaults={{ kind: "decimo_terceiro" }}
        />
      </div>
    </div>
  );
}

function ClientsTab() {
  const { data: clients } = useClients();
  return (
    <CrudTable
      table="clients"
      rows={clients ?? []}
      description="Os líderes cadastram clientes novos ao lançar uma receita. Na Fase 2, os clientes passam a vir do Omie."
      fields={[
        { key: "name", label: "Nome", type: "text", required: true },
        { key: "document", label: "CNPJ/CPF", type: "text" },
        { key: "omie_id", label: "Id no Omie", type: "text", hideInTable: true },
        active,
      ]}
      defaults={{ active: true }}
    />
  );
}

function OmieTab() {
  const { data: rows } = useOmieDepartmentUnits();
  const { data: keywords } = useOmieKeywordUnits();
  const { data: allocations } = useOmieCategoryAllocations();
  const { data: units } = useUnits();
  const unitField = {
    key: "unit_id",
    label: "Unidade",
    type: "select",
    required: true,
    options: opts(units),
  } as const;
  return (
    <div className="space-y-8">
      <p className="text-sm text-muted-foreground">
        O realizado do Omie chega por categoria e quase nunca traz departamento. A unidade de cada
        despesa vem, nesta ordem, do departamento do título, do rateio da categoria, da palavra no
        nome da categoria, ou fica “a ratear”. A leitura roda com python3 scripts/omie-sync.py
        (somente leitura).
      </p>
      <div className="space-y-2">
        <h2 className="text-lg font-semibold">Compras no cartão</h2>
        <AppSettingField
          settingKey="card_supplier_keywords"
          label="Fornecedores que são cartão de crédito"
          hint="Separe por vírgula. Nas despesas desses fornecedores (o banco do cartão), o lançamento leva o nome da observação do título, por exemplo Figma ou Adobe."
        />
      </div>
      <div className="space-y-2">
        <h2 className="text-lg font-semibold">Palavras no nome da categoria</h2>
        <CrudTable
          table="omie_keyword_units"
          rows={keywords ?? []}
          description="Se o nome da categoria contém a palavra (inteira ou frase, sem diferenciar acento), a despesa é da unidade. Vale a maior prioridade; empatando, a palavra mais longa. Ex.: “Financeiro Essencial” (treinamento, prioridade 20) vence “Financeiro” (a unidade)."
          fields={[
            { key: "keyword", label: "Palavra", type: "text", required: true },
            unitField,
            { key: "priority", label: "Prioridade", type: "number", integer: true, required: true },
          ]}
          defaults={{ priority: 0 }}
        />
      </div>
      <div className="space-y-2">
        <h2 className="text-lg font-semibold">Rateio por categoria</h2>
        <CrudTable
          table="omie_category_allocations"
          rows={allocations ?? []}
          description="Divide uma categoria entre unidades, por exemplo Marketing e Publicidade: 0,4 Agência, 0,3 Consultoria, 0,3 Educação. As partes são ajustadas para somar 100%. Vale mais que as palavras. Também se faz direto na página Realizado Omie, em “Ratear”."
          fields={[
            {
              key: "category_name",
              label: "Categoria do Omie (nome exato)",
              type: "text",
              required: true,
            },
            unitField,
            { key: "share", label: "Parte (0 a 1)", type: "number", required: true },
          ]}
          defaults={{}}
        />
      </div>
      <div className="space-y-2">
        <h2 className="text-lg font-semibold">Departamentos do Omie</h2>
        <CrudTable
          table="omie_department_units"
          rows={rows ?? []}
          description="Que unidade do app cada departamento do Omie representa. O nome é o mesmo nas três empresas; um departamento filho (Receitas Fixas Agência) herda a unidade do pai (Agência). Vale mais que o rateio e as palavras."
          fields={[
            { key: "department_name", label: "Departamento no Omie", type: "text", required: true },
            unitField,
          ]}
          defaults={{}}
        />
      </div>
    </div>
  );
}

function PayrollTablesTab() {
  const { data: brackets } = usePayrollBrackets();
  const { data: constants } = usePayrollConstants();
  return (
    <div className="space-y-8">
      <div className="space-y-2">
        <h2 className="text-lg font-semibold">Faixas de INSS e IRRF</h2>
        <CrudTable
          table="payroll_tax_brackets"
          rows={brackets ?? []}
          description="Tabelas do INSS e do IRRF do empregado (valem para qualquer vínculo; o que muda por vínculo são os encargos patronais, em Parâmetros). Cada conjunto de faixas vale a partir da data de vigência; no ano seguinte, cadastre o novo conjunto com a nova data. Alíquotas em fração: 0,075 = 7,5%. Deixe o limite superior vazio na última faixa do IRRF."
          fields={[
            {
              key: "table_key",
              label: "Tabela",
              type: "select",
              required: true,
              options: [
                { value: "inss", label: "INSS" },
                { value: "irrf", label: "IRRF" },
              ],
            },
            { key: "valid_from", label: "Vigência (AAAA-MM-DD)", type: "text", required: true },
            { key: "lower_bound", label: "De (R$)", type: "number", required: true },
            { key: "upper_bound", label: "Até (R$)", type: "number" },
            { key: "rate", label: "Alíquota", type: "number", required: true },
            { key: "deduction", label: "Parcela a deduzir (R$)", type: "number", required: true },
          ]}
          defaults={{ table_key: "inss", deduction: 0 }}
        />
      </div>
      <div className="space-y-2">
        <h2 className="text-lg font-semibold">Constantes do IRRF</h2>
        <CrudTable
          table="payroll_tax_constants"
          rows={constants ?? []}
          description="Dedução por dependente, desconto simplificado e os valores da redução da Lei 15.270. Para mudar um valor, cadastre uma nova linha com a nova vigência: a mais recente até a data do cálculo vale."
          fields={[
            { key: "key", label: "Chave", type: "text", required: true, hideInTable: true },
            { key: "label", label: "Descrição", type: "text", required: true },
            { key: "valid_from", label: "Vigência (AAAA-MM-DD)", type: "text", required: true },
            { key: "value", label: "Valor", type: "number", required: true },
          ]}
          defaults={{}}
        />
      </div>
    </div>
  );
}

function CalcRulesTab() {
  const { data: rules } = useCalcRules();
  const { data: lines } = useDreLines();
  const { data: defs } = useParameterDefinitions();
  const { data: types } = useRevenueTypes();
  const { data: contractTypes } = useContractTypes();
  const { data: accounts } = useAccounts();
  return (
    <CrudTable
      table="calc_rules"
      rows={rules ?? []}
      description="Cada regra gera um valor na linha da DRE escolhida: base × parâmetro. Ex.: Comissão comercial = receita (exceto parceiros) × comissão comercial. Para criar ou editar um parâmetro com o cálculo dele, use a página Parâmetros."
      fields={[
        { key: "name", label: "Nome", type: "text", required: true },
        {
          key: "target_dre_line_id",
          label: "Linha da DRE",
          type: "select",
          required: true,
          options: opts(
            (lines ?? []).filter((l) => l.kind === "calculada" || l.kind === "lancada"),
          ),
        },
        {
          key: "parameter_definition_id",
          label: "Parâmetro",
          type: "select",
          required: true,
          options: (defs ?? []).map((d) => ({ value: d.id, label: d.label })),
        },
        {
          key: "base_kind",
          label: "Base",
          type: "select",
          required: true,
          options: [
            { value: "receita", label: "Receita" },
            { value: "despesa", label: "Despesa" },
            { value: "salario", label: "Remuneração das pessoas" },
            { value: "headcount", label: "Pessoas ativas no mês" },
          ],
        },
        {
          key: "payroll_group",
          label: "Na visão da folha",
          type: "select",
          noneLabel: "Não se aplica",
          options: [
            { value: "encargo", label: "Encargo patronal" },
            { value: "provisao", label: "Provisão" },
            { value: "beneficio", label: "Benefício" },
          ],
          hint: "Só para bases de remuneração e pessoas ativas: define onde o valor aparece no detalhe por colaborador.",
        },
        {
          key: "on_provisions",
          label: "Incide sobre 13º e férias",
          type: "boolean",
          hideInTable: true,
          hint: "Só para encargos sobre a remuneração: aplica o percentual também sobre o 13º e o terço de férias.",
        },
        {
          key: "revenue_type_ids",
          label: "Só os tipos de receita",
          type: "multi",
          options: opts(types),
          emptyLabel: "Todos",
        },
        {
          key: "exclude_revenue_type_ids",
          label: "Exceto os tipos de receita",
          type: "multi",
          options: opts(types),
          emptyLabel: "Nenhum",
          hint: "Todos os tipos entram, menos estes. Um tipo criado depois já entra na regra sozinho.",
        },
        {
          key: "contract_type_ids",
          label: "Só os vínculos",
          type: "multi",
          options: opts(contractTypes),
          emptyLabel: "Todos",
        },
        {
          key: "account_ids",
          label: "Só as contas",
          type: "multi",
          options: opts(accounts),
          emptyLabel: "Todas",
          hideInTable: true,
        },
        active,
        order,
      ]}
      defaults={{ base_kind: "receita", active: true, sort_order: 0, on_provisions: false }}
    />
  );
}
