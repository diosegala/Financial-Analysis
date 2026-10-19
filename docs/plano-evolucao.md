# Plano de evolução — Planejamento Financeiro CUPOLA

> De MVP gerado no Lovable para o app oficial de planejamento financeiro, ligado ao ERP e servindo de base para decisões.
> Versão 1 · 18/10/2026

## 1. Princípios

1. **O ERP é a fonte da verdade do realizado e dos cadastros mestres** (clientes, categorias, departamentos, produtos). **O app é a fonte da verdade do plano.** Os dois usam o mesmo plano de contas, e por isso dá para comparar orçado com realizado.
2. **Nada fixo no código.** Anos, versões, unidades, produtos, eventos, tipos de receita, vínculos, estrutura da DRE, parâmetros e regras de cálculo são editáveis pela tela. O código só conhece os conceitos (o que é uma "linha da DRE" ou uma "regra de comissão"), nunca os valores.
3. **Um único cálculo.** A DRE é calculada no banco. Tela, painéis, exportação para Excel e BI leem a mesma função, então o mesmo número aparece igual em todo lugar.
4. **Todo número é rastreável.** Do total da DRE se chega à linha lançada e, no realizado, ao título no ERP. Toda mudança fica na auditoria.
5. **O `main` está sempre funcionando.** Ele sincroniza com o Lovable. O trabalho é feito em branches, com PR e testes passando antes do merge.

## 2. Premissas a confirmar

| #   | Premissa                                                                                          | Por que importa                                                        |
| --- | ------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| P1  | ✅ Confirmado: o ERP é o **Omie**                                                                 | Define a integração inteira                                            |
| P2  | ✅ Confirmado: **10/11** é o prazo final para os líderes lançarem o orçamento de 2027             | Define o que entra na Fase 1 e o que fica para depois                  |
| P3  | A DRE é por **competência**, não por caixa                                                        | Muda qual data do Omie vale como "mês"                                 |
| P4  | Departamentos do Omie = unidades da CUPOLA, e as categorias do Omie são usadas com consistência   | A qualidade do realizado depende disso. É o **maior risco** do projeto |
| P5  | ✅ Verificado em 18/10: o banco não tem lançamentos (só dados iniciais e o usuário do financeiro) | Permite trocar o modelo de dados agora, sem migrar nada                |

## 3. Arquitetura alvo

```
            ┌──────────── Omie (fonte da verdade do realizado) ───────────┐
            │ departamentos · categorias · clientes · produtos · títulos   │
            └──────────────────────────────┬──────────────────────────────┘
                                           │ sincronização agendada (Edge Function + pg_cron)
                                           ▼
             omie_raw_* (cópia fiel)  →  mapeamentos (tela)  →  actual_entries (realizado)
                                                                     │
  Telas de cadastro e grades ──► plan_lines + plan_values (plano) ───┤
                                                                     ▼
                         dre(versão, cenário, unidades)  ← função no Postgres
                                                                     │
                     DRE · Cenários · Orçado × Realizado · Painéis · Excel · BI
```

## 4. Novo modelo de dados

O banco está vazio (P5), então **este é o momento mais barato** de acertar o modelo. As tabelas atuais de lançamento (`revenue_entries`, `payroll_entries`, `expense_entries`) são substituídas por um padrão único de "linha + valores mensais". Esse padrão resolve de uma vez quatro bugs da análise: duplicidade, renomear e excluir, limite de 1.000 linhas e linha de folha órfã.

### Ciclo de planejamento (acaba com o ano fixo)

- **`budget_versions`**: ano, nome ("Orçamento 2027", "Forecast Abr/27"), tipo (orçamento | forecast), status (rascunho → em coleta → em aprovação → aprovado → travado), versão de origem e primeiro mês editável.
- **`scenarios`** passa a pertencer a uma versão. Variações de receita e despesa, o alvo de cada variação (folha entra ou não) e o "oficial" garantido por índice único parcial.

### Estrutura e plano de contas (acaba com a DRE fixa)

- **`dre_lines`**: código, nome, ordem, tipo (lançada | calculada | subtotal), sinal e fórmula do subtotal. A tela da DRE é desenhada a partir desta tabela.
- **`accounts`** (plano de contas): ligada a uma `dre_line`, com código da categoria no Omie e uso restrito a algumas unidades, se precisar. É global: "Aluguel" existe uma vez só, e não uma vez por unidade.

### Cadastros

- **`units`**: editável (nome, tipo negócio/apoio, ativa, código do departamento no Omie).
- **`clients`**, **`products`**: id no Omie. O produto tem unidade, tipo de receita padrão e custo de produto padrão (% ou R$).
- **`events`** (Educação): produto, mês, quantidade de vagas, preço, custo por participante e custo fixo. Receita e despesa de produto são **geradas a partir disso**.
- **`revenue_types`**: nome, meses de recorrência (6, 12…), máximo de meses (variável ≤ 3), base de comissão.
- **`contract_types`** (vínculos): CLT, sócio, estagiário…, cada um com seu conjunto de encargos e provisões.
- **`people`**: vínculo, mês de entrada e mês de saída, salário base e reajustes (mês + %).

### Parâmetros e regras (acaba com as chaves fixas)

- **`parameter_definitions`**: chave, rótulo, tipo (% ou R$), escopos permitidos, mínimo e máximo. **Zero é permitido.**
- **`parameter_values`**: definição, escopo (global, unidade, vínculo ou tipo de receita), valor e vigência a partir de qual mês e versão. O valor mais específico tem prioridade sobre o global.
- **`calc_rules`**: linha da DRE de destino = base × parâmetro. Exemplos: "Comissão comercial = receitas dos tipos X, Y × comissao_comercial" e "Encargos CLT = salário CLT × inss_patronal + fgts + provisão de 13º e férias". Comissões, impostos e encargos deixam de ficar escritos no código.

### Fatos

- **`plan_lines`**: versão, unidade, conta, dimensões opcionais (cliente, produto, evento, pessoa, tipo de receita), descrição e origem (manual | gerada).
- **`plan_values`**: linha, mês, valor, com **chave única (linha, mês)**. Renomear ou excluir é feito na linha. Copiar uma versão é copiar as linhas.
- **`actual_entries`**: realizado. Origem (`omie` | `planilha`), id externo único por origem (a importação pode rodar de novo sem duplicar), mês de competência, conta, unidade, cliente, valor e link para o documento ou para a planilha e linha de onde veio.
- **`imports`**: cada planilha importada, com arquivo, quem importou, período, mapeamento usado e status. Permite desfazer uma importação inteira.

### Governança

- **`unit_submissions`**: versão × unidade, com status, quem enviou, quem aprovou e comentários. Um trigger bloqueia gravação quando a unidade está enviada, aprovada ou travada (o financeiro pode reabrir).
- **`allocation_rules`** (rateio): unidade de apoio → unidades de negócio, por %, headcount ou receita. Vale por versão.
- **`variance_comments`**: justificativa do líder para cada desvio relevante (Fase 3).

## 5. Fases

Tamanhos: **P** ≈ até 1 dia · **M** ≈ 2–4 dias · **G** ≈ 1–2 semanas.

### Fase 0: fundação e correções rápidas (esta semana)

| Item                                                                                                                                                       | Tam. |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| Ambiente local com bun. Testes, lint e typecheck rodando                                                                                                   | P    |
| GitHub Action rodando testes, lint e typecheck em todo PR                                                                                                  | P    |
| **Caminho para aplicar migrations** (Supabase CLI ligada ao projeto `ausgdcxhlrgacnmdhscm`, ou acesso do conector a esse projeto). É pré-requisito de tudo | P    |
| `parseNum`: aceitar `1234.56` e `1.234,56` sem ambiguidade (ponto só é milhar se vier seguido de 3 dígitos). Testes cobrindo os casos                      | P    |
| Parâmetro com valor zero permitido                                                                                                                         | P    |
| % de cenário arredondado na exibição. Não gravar quando o valor não mudou                                                                                  | P    |
| ~~"Marcar oficial" atômico~~ → movido para a migration da Fase 1, que refaz a tabela de cenários                                                           | —    |

Os bugs estruturais (limite de 1.000 linhas, duplicidade, renomear e excluir, folha órfã) **não** são corrigidos nas tabelas atuais. Eles somem com o modelo novo da Fase 1, e corrigir nas tabelas velhas seria trabalho jogado fora.

### Fase 1: modelo novo e tudo editável (até 10/11)

**1a. Banco**

- Migration com o modelo da seção 4. As tabelas antigas, vazias, são removidas. Políticas de acesso reescritas e cobertas por testes no banco (pgTAP).
- Função `dre(version_id, scenario_id, unit_ids[])`, que devolve linha × mês já somado e calculado no banco. Testes da vigência de parâmetros, das regras, dos cenários e dos subtotais.
- Dados iniciais: as unidades atuais, uma DRE padrão (as linhas de hoje), os vínculos com os encargos legais como valores iniciais **editáveis**, e a versão "Orçamento 2027".

**1b. Tela de Configurações** (só o financeiro). Abas: Versões e cenários · Unidades · Estrutura da DRE · Plano de contas · Tipos de receita · Vínculos · Produtos · Eventos · Clientes · Parâmetros · Regras de cálculo. Cada aba tem criar, editar, desativar e auditoria.

**1c. Grades de lançamento** (Receitas, Folha, Despesas e uma nova Eventos)

- Adicionar, renomear e excluir linha, com confirmação e registro na auditoria.
- Navegação pelo teclado, **colar uma faixa do Excel**, "repetir até dezembro", "reajustar X% a partir do mês".
- Tipo de receita recorrente preenche os meses sozinho. Variável avisa quando passa do máximo de meses.
- Folha: entrada e saída de pessoas. Encargos, provisões e benefícios calculados por vínculo, a partir dos parâmetros.
- Eventos: vagas × preço gera a receita. Custo por participante e custo fixo geram a despesa de produto.
- A unidade, a versão e o cenário escolhidos ficam **na URL**: o link pode ser compartilhado e sobrevive ao recarregar a página.

**1d. Coleta e aprovação.** O líder envia a unidade, o financeiro aprova ou devolve com comentário, e o que foi aprovado fica travado. Um painel mostra o status das unidades na versão. Isso estava previsto para a Fase 2, mas sem esse fluxo não há "orçamento oficial".

**1e. Usuários.** Convite por e-mail (o usuário define a própria senha), editar perfil e unidades, desativar. Validação de dados nas funções do servidor. Criação em passos que não deixam usuário sem perfil.

**1f. Exportar** a DRE e as grades para Excel.

**1g. Histórico do Omie e "Gerar previsão"**

As planilhas históricas não estão disponíveis (18/10). A fonte do histórico passa a ser o **Omie**. Para o botão ter dados até 10/11, a **carga do histórico do Omie (só leitura)** sai da Fase 2 e entra aqui: departamentos, categorias e títulos de 2023 em diante, com a tela de mapeamento. A sincronização contínua, a conciliação e o agendamento continuam na Fase 2.

- **Importador de planilhas:** fica no backlog, para o caso de surgirem planilhas ou exportações de Excel do Omie para períodos em que o Omie não é confiável.
- **Botão "Gerar previsão"** (o "estou com sorte") por unidade e seção:
  - Base: último ano, média dos últimos N anos ou o mesmo mês do ano anterior (mantém a sazonalidade).
  - Correção: % global, com ajuste opcional por unidade ou por linha (ex.: IPCA nas despesas e meta de crescimento na receita). Os percentuais ficam salvos como parâmetros da versão.
  - Prévia lado a lado (histórico, correção, previsto) antes de aplicar.
  - O resultado vira linhas comuns da grade, marcadas como "gerado do histórico", editáveis como qualquer outra linha. Rodar de novo **não apaga o que o líder editou à mão**.
  - Cuidados já previstos: a folha é gerada por pessoa (quem saiu não volta), contratos recorrentes encerrados e eventos pontuais aparecem destacados para revisão, em vez de serem copiados sem critério.

**Se o prazo apertar, sai primeiro:** a carga do histórico do Omie e o "Gerar previsão" (sem histórico, o botão não tem o que usar; os líderes lançam manualmente), regras de cálculo editáveis pela tela (os valores iniciais ficam e a edição vem depois), exportação para Excel e aba de Clientes. **Não sai:** modelo novo, versões, grades editáveis e aprovação.

### Fase 2: conexão com o Omie (nov–dez, pronta antes de janeiro/27)

| Item                                                                                                                                                                                                                                                                      | Tam. |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| Credenciais do Omie (app_key e app_secret) guardadas como segredo no Supabase. Nunca no código nem no navegador                                                                                                                                                           | P    |
| Edge Function `omie-sync` por entidade: departamentos, categorias, clientes, produtos e serviços, contas a receber e a pagar (com a distribuição por departamento). Paginação, só busca o que mudou, respeita os limites da API do Omie e pode rodar de novo sem duplicar | G    |
| Agendamento com pg_cron (ex.: a cada hora no horário comercial) e um botão "sincronizar agora". Tela de histórico das sincronizações com os erros                                                                                                                         | M    |
| **Tela de mapeamento**: categoria do Omie → conta, departamento → unidade. Uma fila de "não mapeados" que impede o realizado de sumir em silêncio                                                                                                                         | M    |
| **Conciliação automática**: total do Omie no mês = total do realizado no app. Diferença gera alerta                                                                                                                                                                       | M    |
| Carga do histórico de 2025–2026. Coluna "Realizado 2026" nas grades e sugestão de valor inicial (ex.: média dos últimos 6 meses)                                                                                                                                          | M    |

Planilha × Omie: nos meses em que existe dado do Omie, o **Omie prevalece** e o dado da planilha fica guardado só como referência. A planilha cobre os períodos anteriores ao uso do Omie, ou em que o Omie não é confiável.

Regra de posse: o que vem do Omie é só leitura no app. O app só acrescenta campos próprios (ex.: tipo de receita do produto). Não há gravação de volta no Omie.

### Fase 3: painéis e decisões (a partir de jan/27)

- **Orçado × Realizado × Forecast** por unidade e por linha: variação em R$ e %, semáforo e detalhamento até o título no Omie.
- **Forecast contínuo**: meses fechados mostram o realizado e os meses à frente o plano revisado. Botão para criar uma versão "Forecast mês X" a partir da atual.
- **Fechamento mensal**: um desvio acima de X% (limite editável) pede justificativa do líder. O histórico de justificativas vira aprendizado para o próximo orçamento.
- **DRE consolidada** com rateio das unidades de apoio.
- Painéis:
  - Receita: concentração por cliente, top 10, % recorrente × variável, contratos recorrentes vencendo nos próximos 90 dias (risco de renovação).
  - Margem: %MCL por unidade, produto e evento. Ponto de equilíbrio por unidade.
  - Pessoas: headcount e custo por unidade, custo por vínculo, peso da folha na receita.
  - Caixa: fluxo projetado a partir de contas a receber e a pagar do Omie mais o plano.
- **Agente de alerta de folha (D3):** quando um cenário deixa a unidade abaixo de um limite definido pelo financeiro (ex.: %MCL mínimo, ou folha acima de X% da receita), o app calcula quanto de folha precisaria ser reduzido para voltar ao limite. Um agente de IA (Claude) explica o alerta em linguagem natural: quanto cortar, a partir de quando, e o impacto por vínculo. O cálculo é feito pelo app, sem IA, para que o número seja auditável; a IA só interpreta e comunica. Cuidado: os dados de salário enviados à API vão agregados por vínculo ou unidade, nunca por pessoa.
- Alertas por e-mail (sincronização com falha, desvio alto, prazo de envio do orçamento).
- Acesso de leitura às visões do banco para uma ferramenta de BI (Metabase ou Looker Studio), se surgir a necessidade.

## 6. Qualidade e segurança (em todas as fases)

- Testes no banco para acesso por perfil e para a função `dre`. Testes de interface nas grades. CI obrigatória no PR.
- Tipos do Supabase gerados de novo a cada migration.
- Salário é dado sensível (LGPD): acesso mínimo, auditoria de leitura da folha a considerar, e backup com restauração para um momento passado (PITR) ativado.
- Monitoramento de erros em produção.

## 7. Convivência com o Lovable

- Durante a Fase 1 (troca do modelo), **evitar prompts no Lovable**. Ele não conhece o modelo novo e pode gerar código contra as tabelas antigas.
- Depois da Fase 1, o Lovable continua útil para ajustes visuais. Vale atualizar o `.lovable/plan` com este modelo para ele trabalhar a partir disso.
- Nunca reescrever histórico já publicado (regra do AGENTS.md).

## 8. Decisões de negócio (respondidas em 18/10)

| #   | Decisão                                                                                                                                                                               | Como entra no app                                                                                            |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| D1  | Encargos são **diferentes por vínculo** e informados pelo financeiro                                                                                                                  | Parâmetros com escopo "vínculo", editados na página Parâmetros, que só o perfil administrador acessa         |
| D2  | **Educação sempre entra** na base da comissão comercial                                                                                                                               | Regra inicial da comissão comercial inclui todos os tipos de receita, exceto parceiros                       |
| D3  | A variação de despesa do cenário **não afeta a folha** diretamente. Mas, se o cenário pessimista for muito pessimista, um **agente de IA alerta que desligamentos serão necessários** | Variação de despesa não se aplica à folha. Alerta: Fase 3, item "Agente de alerta de folha"                  |
| D4  | **VP só lê**, não lança valores                                                                                                                                                       | Políticas de acesso: escrita só para financeiro e líder (na própria unidade)                                 |
| D5  | **Comissões variam por produto e unidade.** O imposto é o mesmo para toda a empresa, que é do **Lucro Real**                                                                          | Parâmetros de comissão com escopo produto e unidade (o mais específico prevalece). Imposto com escopo global |
| D6  | **Líder não vê outros usuários**                                                                                                                                                      | Perfis visíveis só para o próprio usuário e para financeiro, VP e CEO                                        |

**Em aberto:**

- P3 e P4 da seção 2.
- "Administrador" em D1 é o perfil **financeiro** atual ou um perfil novo? A suposição até a resposta: o perfil financeiro.
- **Lucro Real (D5):** um "imposto = % da receita" único simplifica demais. No Lucro Real, PIS (1,65%) e COFINS (7,6%) são não cumulativos, e há créditos sobre parte das despesas. O ISS varia por município. IRPJ e CSLL incidem sobre o lucro, não sobre a receita. Proposta: na DRE da unidade, "impostos sobre a receita" = PIS + COFINS + ISS, como parâmetros globais separados, e uma marca opcional "gera crédito de PIS/COFINS" nas contas de despesa. IRPJ e CSLL só na DRE consolidada. **Confirmar com a contabilidade.**

## 9. Próximos passos

1. ✅ Fase 0 concluída (PR #1, 18/10).
2. ✅ Migrations aplicadas pela Supabase CLI, ligada ao projeto.
3. Fase 1: migration do modelo novo, revisada antes de ser aplicada.
4. Credenciais da API do Omie (app_key e app_secret), guardadas como segredo no Supabase, para a carga do histórico.
