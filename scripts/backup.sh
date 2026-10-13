#!/usr/bin/env bash
# Резервна копія БД: pg_dump → стиснутий дамп → шифрування AES-256 (gpg). Дамп містить персональні дані
# покупців, тому НІКОЛИ не зберігається у відкритому вигляді.
#
# Змінні: DATABASE_URL (рядок підключення), BACKUP_PASSPHRASE (пароль шифрування; зберігайте його окремо
# в менеджері паролів — без нього копію не відкрити), OUT_FILE (необов'язково, за замовчуванням backup.dump.gpg).
set -euo pipefail
: "${DATABASE_URL:?DATABASE_URL не задано}"
: "${BACKUP_PASSPHRASE:?BACKUP_PASSPHRASE не задано}"
OUT_FILE="${OUT_FILE:-backup.dump.gpg}"

pg_dump --format=custom --compress=6 --no-owner --no-privileges "$DATABASE_URL" \
  | gpg --batch --yes --pinentry-mode loopback --symmetric --cipher-algo AES256 \
        --passphrase "$BACKUP_PASSPHRASE" --output "$OUT_FILE"

SIZE=$(stat -c%s "$OUT_FILE" 2>/dev/null || stat -f%z "$OUT_FILE")
if [ "$SIZE" -lt 2048 ]; then echo "Підозріло малий файл копії ($SIZE байт)" >&2; exit 1; fi
sha256sum "$OUT_FILE" > "$OUT_FILE.sha256" 2>/dev/null || shasum -a 256 "$OUT_FILE" > "$OUT_FILE.sha256"
echo "Копію створено: $OUT_FILE ($SIZE байт)"
echo "$SIZE" > "$OUT_FILE.size"
