# Planejamento Financeiro CUPOLA — estado e próximos passos

> App oficial do orçamento de 2027. O Omie é a fonte da verdade do realizado (só leitura); o app é a fonte da verdade do
> plano. Atualizado em 24/10/2026. Prazo: líderes lançam até 10/11/2026.

## Princípios

1. **Omie só leitura.** O app lê categorias, departamentos e contas a pagar; nunca escreve no Omie.
2. **Nada fixo no código.** Anos, unidades, contas, parâmetros, regras de cálculo e de atribuição são dados editáveis.
3. **Um único cálculo.** A DRE, a meta e a base de despesas são calculadas no banco; telas e exportação leem as mesmas
   funções.
4. **Simples para quem usa.** O que já temos (planilhas, Omie) chega carregado; o financeiro confere e ajusta, o líder lança
   descrição, origem e valores.
5. **`main` sempre funcionando** (sincroniza com o Lovable): branch, PR, testes e só então merge.

## O que o app faz hoje

| Área           | Como funciona                                                                                                                                                                                                           |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Início         | Financeiro: "Por onde começar" (contas, folha, base de despesas, meta, líderes, coleta). Líder: a meta, o que já lançou e o que falta.                                                                                  |
| Contas         | Uma conta por categoria do Omie, única por nome e tipo, com grupo, período e tratamento (lançável, calculada pelo app, fora da DRE). Carregadas da planilha de categorias em 24/10.                                     |
| Folha          | Uma linha de 12 meses editável por pessoa (sem nomes, só ID), carregada da planilha em 24/10. INSS e IRRF por tabela com vigência; encargos de CLT por item; aba de salário líquido e encargos.                         |
| Despesas       | Base de 2027 gerada do realizado de 2026 no Omie, com reajuste geral e edição linha a linha. Sem unidade → ADM; benefícios sem unidade seguem as pessoas.                                                               |
| Realizado Omie | Contas a pagar das 3 empresas por categoria; unidade pelo departamento, rateio ou palavra no nome (eventos e treinamentos = Educação). Leitura por `scripts/omie-sync.py`.                                              |
| Metas          | Alvo por cenário (R$ ou margem); receita necessária = (alvo + custos fixos − receita de apoio líquida) ÷ (1 − alíquota variável); distribuição por unidade e mês; publicar libera para os líderes; caminho para o alvo. |
| Receitas       | Origem de cada linha (carteira, renovação, venda nova) e o painel meta × plano com o saldo a vender. Tipo de receita, cliente e produto são opcionais.                                                                  |
| Eventos        | Evento com itens de receita (ingressos, patrocínio) e de custo, por mês.                                                                                                                                                |
| Coleta         | Líder envia; financeiro aprova, devolve ou reabre; versão travada fecha tudo.                                                                                                                                           |

## Em aberto

- Alíquota de impostos sobre a receita financeira (contabilidade). Começa em 0%.
- Provisão de férias e 13º: modelo de competência (provisão mensal) ou no mês em que a pessoa tira.
- Créditos de PIS/COFINS (Lucro Real) ainda não modelados.
- Leitura das contas a receber do Omie e a sincronização automática (hoje manual).
- Rateio dos custos compartilhados que ficaram na ADM, se o Fábio quiser distribuí-los.

## Decisões de negócio registradas

Encargos por vínculo (CLT pela tabela; sócio e estagiário pela tela) · comissões por produto e unidade, impostos iguais
para a empresa (Lucro Real) · VP e CEO só leem · líder lança só na própria unidade e não edita o que já lançou ·
administrador = financeiro · líderes lançam no fluxo com meta publicada · alvo cobre apoio e negócio · distribuição por
unidade e mês é manual · eventos e treinamentos pertencem à Educação · despesas sem unidade entram na ADM.

## Próximos passos

1. Fábio confere contas, folha e base de despesas; aplica o reajuste geral.
2. Define o alvo de cada cenário, calcula e publica a meta.
3. Libera os líderes; acompanha a coleta até 10/11.
4. Depois do orçamento: realizado × orçado com o Omie, forecast mensal e painéis.
