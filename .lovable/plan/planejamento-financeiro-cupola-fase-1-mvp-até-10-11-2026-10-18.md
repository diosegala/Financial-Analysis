# Planejamento Financeiro CUPOLA — Fase 1 (MVP até 10/11)

## Pré-requisito
Você conecta o seu Supabase pelo painel Cloud (Connectors → Supabase). Só depois disso começo a parte de banco e login.

## Decisões aplicadas
- Folha: só o financeiro lança; o líder vê tudo da própria unidade, inclusive salários individuais.
- Cenários: o "Realista" é lançado; Otimista e Conservador são variações % aplicadas pelo financeiro (receita e despesa separadas). Um cenário é marcado como oficial.
- Escopo: Fase 1 completa. Aprovação, travas, versões, rateio e DRE consolidada ficam para a Fase 2; Omie para a Fase 3. Auditoria básica já entra (é critério de aceite).

## Telas
1. **Login** (e-mail e senha) e redirecionamento por perfil.
2. **Início**: seletor de unidade (líder vê só a sua), ano 2027 e cenário.
3. **Receitas**: grade cliente/produto x 12 meses. Consultoria com tipo (recorrente 6/12 meses, variável até 3 meses, parceiros). Educação por evento/treinamento/produto com despesa de produto.
4. **Folha**: pessoas da unidade (sócio, CLT, estagiário), salário/pró-labore/CIEE por mês, reajuste a partir de um mês. Encargos e benefícios calculados por parâmetro, rescisões lançadas. Edição só para o financeiro.
5. **Despesas**: categorias por unidade x 12 meses. Financeiro cadastra categorias e a linha da DRE de cada uma.
6. **Parâmetros** (só financeiro): imposto, comissão comercial, comissão de parceiro, encargos — cada mudança com data de início e histórico.
7. **Cenários**: definir % de variação, marcar oficial, comparar os três lado a lado.
8. **DRE prevista da unidade**: receita bruta, despesas de produtos, custos indiretos, despesas, comissionamento, impostos, contribuição líquida e %MCL, por mês e total.
9. **Usuários** (só financeiro): convidar, definir perfil e unidades.
10. **Auditoria**: lista de quem alterou o quê e quando.

Unidades iniciais: Agência, Consultoria, Educação (negócio); RH, Financeiro, CRO, ADM, Growth (apoio).

## Visual
Ferramenta financeira sóbria: fundo claro quente, tipografia com números tabulares, grades densas tipo planilha, cor de destaque única. Interface em português.

## Detalhes técnicos
- Tabelas: units, user_roles (financeiro, vp, ceo, lider) + user_units, scenarios, revenue_entries, people, payroll_entries, expense_categories, expense_entries, parameters (valid_from/valid_to), audit_log.
- RLS: líder lê/grava só unidades em user_units; financeiro/VP/CEO leem tudo; CEO sem escrita; folha gravável só pelo financeiro. Funções security definer has_role / has_unit.
- Auditoria por trigger em todas as tabelas de lançamento e parâmetros (antes/depois em JSON).
- Cálculo da DRE em um módulo TypeScript puro: parâmetro vigente por mês, comissões, impostos, MCL, variação de cenário. Testes unitários cobrindo vigência (meses anteriores mantêm valor) e cenários.
- Rotas protegidas em _authenticated; leituras via loaders + React Query.
