#!/usr/bin/env bash
# Restaura um backup gerado por scripts/backup.sh.
#
#   bash scripts/restore.sh "<pasta do backup>" "<url de conexão do banco>"
#
# O banco de destino precisa já ter a estrutura (supabase db push). ESTE SCRIPT APAGA os dados que
# estiverem nele antes de restaurar: confira a URL com atenção. Para não pedir confirmação (testes
# automáticos), defina CONFIRMAR=RESTAURAR.
set -euo pipefail

DIR="${1:?Informe a pasta do backup}"
URL="${2:?Informe a URL de conexão do banco de destino}"

for f in auth.sql data.sql; do [ -f "$DIR/$f" ] || { echo "Não achei $DIR/$f"; exit 1; }; done
(cd "$DIR" && shasum -a 256 -c SHA256SUMS >/dev/null) || { echo "Os arquivos do backup não conferem com SHA256SUMS."; exit 1; }

HOST=$(echo "$URL" | sed -E 's#^[a-z]+://[^@]*@##; s#[/?].*$##')
echo "Destino: $HOST"
if [ "${CONFIRMAR:-}" != "RESTAURAR" ]; then
  read -r -p "Isto APAGA os dados atuais de $HOST. Digite RESTAURAR para continuar: " answer
  [ "$answer" = "RESTAURAR" ] || { echo "Cancelado."; exit 1; }
fi

psql "$URL" -v ON_ERROR_STOP=1 -q <<'SQL'
DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' LOOP
    EXECUTE format('TRUNCATE public.%I CASCADE', r.tablename);
  END LOOP;
  TRUNCATE auth.users CASCADE;
END $$;
SQL

psql "$URL" -v ON_ERROR_STOP=1 -q -f "$DIR/auth.sql"
psql "$URL" -v ON_ERROR_STOP=1 -q -f "$DIR/data.sql"
echo "Restauração concluída."
