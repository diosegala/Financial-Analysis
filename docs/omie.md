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

- **Contas a pagar**, sem os títulos cancelados, por **data de emissão** do título. Títulos pagos ficam em "Pago"; a vencer e
  atrasados, em "Em aberto" (já provisionados no Omie).
- Cada título entra pela categoria do rateio, dividido pelo departamento quando houver.
- **Quase nenhum título tem departamento** (em 2026, cerca de 2% do valor da PW e nada nas outras duas). Por isso a unidade é
  escolhida ao planejar: em "Planejar", informe a unidade e a parte do realizado que pertence a ela.
- Departamentos do Omie viram unidades do app em Configurações → Omie. Um departamento filho herda a unidade do pai.
- Categoria do Omie e conta do app são ligadas pelo nome (sem o ano: "… - 2026" encontra "… - 2027"). Categorias de folha,
  encargos e impostos são calculadas pelo app e não viram linha.

## Ainda não feito

Receitas (contas a receber), a leitura pela data de competência do Omie, e a sincronização automática.
