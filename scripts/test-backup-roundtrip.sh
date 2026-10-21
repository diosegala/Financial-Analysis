#!/usr/bin/env bash
# Teste: faz backup do banco LOCAL, restaura e confere que todas as tabelas voltam iguais.
# Só roda contra banco local. Usado na CI e para validar mudanças nos scripts de backup.
set -euo pipefail
cd "$(dirname "$0")/.."

URL="${DB_URL:-postgresql://postgres:postgres@127.0.0.1:54322/postgres}"
case "$URL" in
  *@127.0.0.1:*|*@localhost:*) ;;
  *) echo "Este teste só roda contra banco local."; exit 1 ;;
esac

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

counts() {
  psql "$URL" -At -F' ' -c "
    select 'public.' || table_name,
           (xpath('/row/c/text()', query_to_xml(format('select count(*) as c from public.%I', table_name), false, true, '')))[1]::text
    from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE'
    union all select 'auth.users', count(*)::text from auth.users
    order by 1"
}

# Garante ao menos um usuário e um perfil, como no app real.
psql "$URL" -q -c "
  insert into auth.users (id, email) values ('00000000-0000-0000-0000-00000000b4c4', 'backup-teste@cupola.local')
  on conflict do nothing;
  insert into public.user_roles (user_id, role) values ('00000000-0000-0000-0000-00000000b4c4', 'financeiro')
  on conflict do nothing;"

counts > "$TMP/antes.txt"
SOURCE=local BACKUP_DIR="$TMP/out" bash scripts/backup.sh
CONFIRMAR=RESTAURAR bash scripts/restore.sh "$(ls -d "$TMP"/out/*/ | head -1)" "$URL"
counts > "$TMP/depois.txt"

if diff "$TMP/antes.txt" "$TMP/depois.txt"; then
  echo "OK: $(wc -l < "$TMP/depois.txt" | tr -d ' ') tabelas voltaram iguais ($(awk '{s+=$2} END {print s}' "$TMP/depois.txt") linhas)."
else
  echo "ERRO: o banco restaurado difere do original."; exit 1
fi
