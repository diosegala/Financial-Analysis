#!/usr/bin/env bash
# Backup manual do banco do planejamento financeiro, pronto para guardar no Google Drive.
#
#   bash scripts/backup.sh                     # projeto real (precisa de `supabase login` e `supabase link`)
#   SOURCE=local bash scripts/backup.sh        # banco local, para testes
#   BACKUP_DIR="/outra/pasta" bash scripts/backup.sh
#
# Gera uma pasta com data e hora contendo:
#   data.sql    dados do app (restaurável)       auth.sql    usuários e vínculos com o Google (restaurável)
#   schema.sql  estrutura, só para consulta      csv/        uma planilha por tabela, para abrir no Excel
#   LEIA-ME.txt como restaurar                   SHA256SUMS  conferência dos arquivos
set -euo pipefail
cd "$(dirname "$0")/.."

SOURCE="${SOURCE:-linked}"
DEST_ROOT="${BACKUP_DIR:-$HOME/Google Drive/Backups CUPOLA/Planejamento Financeiro}"
OUT="$DEST_ROOT/$(date +%Y-%m-%d_%H%M)"
FLAG="--$SOURCE"

# Tabelas de login que não precisam ir no backup (sessões, tokens etc.). Ficam só usuários e identidades.
AUTH_EXCLUDE="auth.audit_log_entries,auth.custom_oauth_providers,auth.flow_state,auth.instances,auth.oauth_clients,auth.sessions,auth.mfa_amr_claims,auth.mfa_factors,auth.mfa_challenges,auth.mfa_recovery_code_sets,auth.mfa_recovery_codes,auth.oauth_authorizations,auth.oauth_client_states,auth.oauth_consents,auth.one_time_tokens,auth.refresh_tokens,auth.sso_providers,auth.saml_providers,auth.saml_relay_states,auth.scim_tokens,auth.scim_users,auth.sso_domains,auth.webauthn_challenges,auth.webauthn_credentials"

mkdir -p "$OUT/csv"
echo "Gravando em: $OUT"

quiet() { grep -vE "new version|recommend updating|Dumping|Dumped|hint:|^ *$" || true; }

supabase db dump "$FLAG" -f "$OUT/schema.sql" 2>&1 | quiet
supabase db dump "$FLAG" --data-only --use-copy --schema public -f "$OUT/data.sql" 2>&1 | quiet
supabase db dump "$FLAG" --data-only --use-copy --schema auth -x "$AUTH_EXCLUDE" -f "$OUT/auth.sql" 2>&1 | quiet

# Confere que os arquivos de dados são restauráveis (têm o cabeçalho e blocos COPY).
for f in data.sql auth.sql; do
  grep -q "session_replication_role" "$OUT/$f" || { echo "ERRO: $f sem cabeçalho de restauração"; exit 1; }
  grep -q '^COPY ' "$OUT/$f" || { echo "ERRO: $f sem dados"; exit 1; }
done

python3 scripts/copy_to_csv.py "$OUT/data.sql" "$OUT/csv" | tee "$OUT/linhas-por-tabela.txt"

cat > "$OUT/LEIA-ME.txt" <<TXT
Backup do Planejamento Financeiro CUPOLA
Gerado em $(date '+%d/%m/%Y %H:%M') — origem: $SOURCE

ATENÇÃO: contém salários, clientes e os usuários do app (inclusive os dados de login).
Guarde só em pasta restrita ao financeiro e a quem administra o app.

Para ler os dados: abra os arquivos da pasta csv/ no Excel ou no Google Planilhas.

Para restaurar (num projeto Supabase novo ou apagando o atual):
  1. Estrutura: no repositório do app, rode  supabase link  e  supabase db push  (aplica as migrations).
  2. Dados:     bash scripts/restore.sh "<esta pasta>" "<url de conexão do banco>"
     O script pede confirmação, porque APAGA os dados que já estiverem no banco de destino.
Guia completo: docs/backup.md
TXT

(cd "$OUT" && shasum -a 256 data.sql auth.sql schema.sql > SHA256SUMS)
echo "Backup concluído: $OUT"
