#!/usr/bin/env bash
# Перевірка, що копію МОЖНА ВІДНОВИТИ: розшифрувати → pg_restore в порожню тестову БД → перевірити, що ключові
# таблиці не порожні. Копія, яку жодного разу не відновлювали, — це лише надія.
#
# Змінні: RESTORE_DATABASE_URL (ПОРОЖНЯ тестова БД! Ніколи не вказуйте робочу), BACKUP_PASSPHRASE,
# IN_FILE (за замовчуванням backup.dump.gpg). Код виходу 0 — відновлення успішне.
set -euo pipefail
: "${RESTORE_DATABASE_URL:?RESTORE_DATABASE_URL не задано}"
: "${BACKUP_PASSPHRASE:?BACKUP_PASSPHRASE не задано}"
IN_FILE="${IN_FILE:-backup.dump.gpg}"

if [ -n "${DATABASE_URL:-}" ] && [ "$DATABASE_URL" = "$RESTORE_DATABASE_URL" ]; then
  echo "RESTORE_DATABASE_URL збігається з робочою БД — зупиняюсь!" >&2; exit 2
fi

gpg --batch --yes --pinentry-mode loopback --decrypt --passphrase "$BACKUP_PASSPHRASE" --output restored.dump "$IN_FILE"
pg_restore --no-owner --no-privileges --exit-on-error --dbname "$RESTORE_DATABASE_URL" restored.dump
rm -f restored.dump

count() { psql "$RESTORE_DATABASE_URL" -tAc "SELECT COUNT(*) FROM $1"; }
FAIL=0
REPORT=""
for t in users products orders terms_versions admin_users site_settings; do
  n=$(count "$t" 2>/dev/null || echo "ПОМИЛКА")
  REPORT="$REPORT $t=$n"
  if [ "$n" = "ПОМИЛКА" ]; then FAIL=1; fi
done
# Мінімум: має бути хоч одна редакція правил і хоч один адмін, інакше копія явно неповна.
for t in terms_versions admin_users; do
  n=$(count "$t" 2>/dev/null || echo 0)
  if [ "$n" -lt 1 ]; then echo "Таблиця $t порожня — копія неповна" >&2; FAIL=1; fi
done
echo "Відновлено:$REPORT"
echo "$REPORT" > restore-report.txt
exit $FAIL
