# Backup manual do planejamento financeiro

O projeto está no plano gratuito do Supabase, que não faz backup que se possa baixar. Este guia cobre o backup manual, gravado no Google Drive.

## O que o backup guarda

Uma pasta com data e hora, por exemplo `2026-10-21_1830`:

| Arquivo                                              | Para quê                                                                                               |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `data.sql`                                           | Todos os dados do app: lançamentos, folha, produtos, parâmetros, cenários, auditoria. **Restaurável.** |
| `auth.sql`                                           | Os usuários e o vínculo com o login do Google. **Restaurável.**                                        |
| `csv/`                                               | Uma planilha por tabela, para abrir no Excel ou no Google Planilhas e conferir os dados.               |
| `schema.sql`                                         | A estrutura do banco, só para consulta (a estrutura de verdade vem das migrations do repositório).     |
| `LEIA-ME.txt`, `SHA256SUMS`, `linhas-por-tabela.txt` | Instruções, conferência dos arquivos e contagem de linhas.                                             |

**Atenção:** a pasta tem salários, clientes e os dados de login dos usuários. Deixe-a numa pasta do Drive restrita ao financeiro e a quem administra o app.

## Como fazer o backup

Precisa do Supabase CLI instalado, com `supabase login` e `supabase link --project-ref ausgdcxhlrgacnmdhscm` feitos (já estão no computador do Dioner).

```sh
cd ~/Financial-Analysis
bun run backup
```

Por padrão, grava em `Google Drive/Backups CUPOLA/Planejamento Financeiro/`. O Google Drive para computador sincroniza a pasta sozinho. Para gravar em outro lugar: `BACKUP_DIR="/caminho/da/pasta" bun run backup`.

**Frequência sugerida:** uma vez por dia enquanto os líderes estiverem lançando (até 10/11) e uma vez por semana depois. Antes de qualquer mudança grande, faça um backup.

O script não apaga backups antigos. De vez em quando, apague à mão os mais antigos.

## Como restaurar

Use quando o projeto for perdido, ou para montar o app num projeto novo do Supabase.

1. Crie o projeto novo, rode `supabase link --project-ref <novo>` e `supabase db push` no repositório. Isso recria a estrutura.
2. Pegue a URL de conexão do banco novo (Supabase → Project Settings → Database → Connection string).
3. Rode:

   ```sh
   bash scripts/restore.sh "<pasta do backup>" "<url de conexão do banco>"
   ```

   O script **apaga os dados que já estiverem no banco de destino** e pede para você digitar `RESTAURAR`. Confira o endereço que ele mostra antes de confirmar.

4. No Supabase novo, configure de novo o login com Google (Authentication → Providers) e os endereços de retorno. O app publicado precisa apontar para o projeto novo.

O script recusa um backup cujos arquivos tenham sido alterados (confere o `SHA256SUMS`).

## Como saber que o backup funciona

`scripts/test-backup-roundtrip.sh` faz um backup de um banco local, restaura e compara todas as tabelas. Ele roda automaticamente na CI a cada mudança. Se o teste quebrar, o backup deixou de ser confiável: avise antes de confiar nos arquivos novos.

Vale também uma conferência humana de vez em quando: abra um dos arquivos de `csv/` e veja se os números batem com o app.
