# Leitura do Omie (somente leitura)

O app **nunca escreve no Omie**. Uma rotina local lê as contas a pagar das três empresas (Central de Conteúdo, PW Cupola e
MKTIMOB) e grava o realizado no banco do planejamento. O realizado do ano anterior aparece em **Realizado Omie** (só o
financeiro) e serve de base para planejar a versão aberta.

## Chaves da API

Um arquivo por empresa, na mesma pasta (`~/Documents/testes_financeiro`, ou outra com `--env-dir`):
`omie_central.env`, `omie_pw.env`, `omie_mktimob.env`. Cada um com `OMIE_APP_KEY` e `OMIE_APP_SECRET`. As chaves ficam só
nesses arquivos: não entram no repositório, no banco nem em mensagens. A rotina chama apenas métodos `Listar*`.

## Como rodar

```
python3 scripts/omie-sync.py --dry-run        # só mostra o resumo, não grava
python3 scripts/omie-sync.py                  # grava no projeto real (precisa de supabase login e supabase link)
python3 scripts/omie-sync.py --year 2025 --year 2026
```

Rodar de novo troca o que existe daquele ano, por empresa. Por ora a rotina é manual; uma execução agendada fica para
depois.

## O que é lido e como é somado

- **Pago = pagamento efetivo**, no mês em que foi pago (movimentos financeiros do Omie): os títulos de contas a pagar, com a
  categoria e o departamento do título, e os lançamentos feitos direto no extrato. As baixas (que repetem os títulos) e as
  transferências entre contas ficam de fora. **Em aberto** = títulos a vencer ou atrasados, no mês do vencimento.
  Decisão de 25/10, para fechar com a planilha do Fábio (antes era a data de emissão do título).
- **Quase nenhum título tem departamento** (em 2026, cerca de 2% do valor da PW e nada nas outras duas). A unidade de cada
  despesa vem, nesta ordem, de:
  1. a **escolha do financeiro** para a categoria: a unidade escolhida na coluna "Unidade" da página Realizado Omie (100%)
     ou a divisão feita em "Dividir" (ex.: Marketing e Publicidade: 40% Agência, 30% Consultoria, 30% Educação). Corrige
     também títulos lançados com o departamento errado no Omie;
  2. o **departamento do título**, quando houver (Configurações → Avançado → Omie; filho herda a unidade do pai);
  3. a **palavra no nome da categoria** (SAAS - Agência → Agência; Summit, Imersão, Insider… → Educação). Maior prioridade
     vence; "Financeiro Essencial" (treinamento) vence "Financeiro" (a unidade);
  4. senão, fica **"a ratear"** e, na base de 2027, entra na ADM.
- **Fornecedor e item**: cada despesa guarda o fornecedor do título. Quando o fornecedor é o banco do cartão de crédito
  (lista editável em Configurações → Avançado → Omie), o nome do lançamento vem da observação do título (o nome da
  ferramenta ou serviço). A base de 2027 tem uma linha por fornecedor ou item dentro da conta; a conta é a soma deles.
- Mudou a unidade de uma categoria? Para levar à base de 2027, use "Gerar de novo" em Despesas (refaz as linhas geradas),
  ou mude uma linha só pelo menu da linha → "Mudar de unidade".
- Em "Planejar", a unidade e a parte vêm dessa atribuição e podem ser trocadas.
- Categoria do Omie e conta do app são ligadas pelo nome (sem o ano: "… - 2026" encontra "… - 2027"). Categorias de folha,
  encargos e impostos são calculadas pelo app e não viram linha.

## Ainda não feito

Receitas (contas a receber), a leitura pela data de competência do Omie, e a sincronização automática.

## Carga inicial (feita uma vez pelo Dioner)

- `bun scripts/load-categories.ts --despesas … --receitas … --review revisao.csv [--apply]`: contas a partir da planilha de
  categorias (coluna "Importar"), com tratamento e linha da DRE pelo grupo do código do Omie. Simula sem `--apply`.
- `bun scripts/load-people.ts --file folha.tsv [--apply]`: folha a partir da planilha de salários (só ID, sem nomes).
- A **base de despesas de 2027** é gerada no app (Despesas → "Gerar base de 2027"), com reajuste geral: cada despesa de
  2026 vira uma linha na conta e na unidade dela; sem unidade, vai para a unidade de `app_settings` (ADM); benefícios e
  rescisões sem unidade são divididos pelas pessoas de cada unidade; categorias com o ano no nome só entram no ano delas.
