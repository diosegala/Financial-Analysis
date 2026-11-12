# Planilha de produtos de Educação

A planilha "[EDU] Produtos | DRE 2027" (Google Sheets) alimenta o plano da unidade Educação. Cada aba é um produto, com a
mesma DRE: receita bruta (ingressos, patrocínio, variável), taxas e impostos sobre a receita, custos e despesas.

## Como a leitura funciona

A Edge Function `edu-sheet-sync` lê a planilha (só leitura) pelo botão **Ler a planilha agora**, em Configurações →
Planilha de Educação e no Planejamento da Educação, e todo dia às 6h de Brasília.

Em cada aba ligada a um produto:

- **Blocos.** Achados pelas fórmulas da coluna D (VALOR), e não pelo número da linha:
  - "Receita Operacional Bruta" soma os blocos de receita;
  - "Custo dos Serviços Prestados" soma os blocos de custo;
  - "Despesas" soma as linhas de despesa;
  - "Taxas sobre ROB" e "Impostos sobre ROB" são achadas pelo rótulo.
- **Meses.** Vêm da data de cada coluna na linha 2. A aba precisa ter os 12 meses do ano da versão; os meses de outros anos
  ficam de fora. Aba sem os 12 meses do ano não é lida, e o aviso aparece na lista de abas.
- **Avisos.** A leitura confere a soma com a Contribuição Líquida da aba e avisa quando um bloco é somado duas vezes na
  própria planilha.

## O que entra no plano

- **Receita:** cada bloco vira uma linha, por exemplo "GPL · Ingressos". A conta segue o tipo do bloco, como as categorias
  do Omie:
  - INGRESSOS vai para a conta da receita do produto (ex.: "GPL Ingressos - 2027");
  - PATROCÍNIO vai para a conta do patrocínio (ex.: "GPL Patrocínio - 2027");
  - os outros blocos (VARIÁVEL, VAGAS EXTRAS) vão para a conta da receita variável;
  - sem a conta do patrocínio ou da variável, o bloco vai para a conta da receita.
- **Custos e despesas:** cada bloco vira uma linha na conta de custo do produto.
- **Taxas e impostos:** vão para as contas "Taxas sobre a receita - planilha de Educação" e "Impostos sobre a receita -
  planilha de Educação", na linha de impostos sobre a receita. As regras de imposto e comissão do app não incidem sobre a
  receita da planilha, para não contar duas vezes.
- **Edição:** as linhas da planilha aparecem com "· da planilha" e não se editam no app. A correção é feita na planilha.
- **Lançamentos manuais:** os que existiam nas contas do produto saem na leitura. As outras despesas da Educação (folha,
  SaaS, viagens etc.) continuam manuais.

## Depois de travar a versão

O plano não muda mais. Cada leitura grava a previsão (`edu_sheet_forecast`), e o Acompanhamento usa esses valores nos meses
abertos, no lugar do que o produto tinha no plano.

## Configuração (uma vez)

1. **Conta de serviço.** No projeto do Google Cloud (pode ser o mesmo do login):
   - ative a Google Sheets API;
   - crie uma conta de serviço, sem papéis, e uma chave JSON.
2. **Chave no Supabase.** Em Edge Functions → Secrets, crie `GOOGLE_SERVICE_ACCOUNT` com o conteúdo inteiro do JSON. Não
   cole a chave em chat nem no repositório.
3. **Compartilhamento.** Compartilhe a planilha com o e-mail da conta de serviço (`…@….iam.gserviceaccount.com`) como
   **Leitor**.
4. **Link e abas.** Em Configurações → Planilha de Educação:
   - cole o link da planilha;
   - leia uma vez;
   - em cada aba, escolha o produto ou clique em **Criar produto** (contas de ingressos, patrocínio, variável e despesa);
   - leia de novo.

A leitura diária usa o endereço e o token do agendamento do Omie (`omie_sync_url` e `omie_sync_token`, no Vault).

## Prévia sem gravar nada

```
python3 scripts/xlsx-to-grid.py "[EDU] Produtos _ DRE 2027.xlsx" grade.json
bun scripts/edu-sheet-preview.ts --grid grade.json --out previa.html [--by-position]
```

A planilha e a prévia têm valores do negócio: guarde-as fora do repositório.
