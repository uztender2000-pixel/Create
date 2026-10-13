#!/usr/bin/env bash
# Повідомляє сайту, що копія створена / відновлення перевірено (він показує це в адмінці та шле сповіщення
# при збої). Використання: heartbeat.sh <backup|restore_test> <true|false> [розмір_байт] [опис]
# Змінні: HEARTBEAT_URL (напр. https://api.example.com/api/internal/backup-heartbeat), BACKUP_HEARTBEAT_TOKEN.
set -uo pipefail
KIND="${1:-backup}"; OK="${2:-true}"; SIZE="${3:-null}"; DETAILS="${4:-}"
[ -z "${HEARTBEAT_URL:-}" ] && { echo "HEARTBEAT_URL не задано — пропускаю"; exit 0; }
DETAILS=$(printf '%s' "$DETAILS" | head -c 400 | tr -d '"\\' | tr '\n' ' ')
curl -fsS -m 20 -X POST "$HEARTBEAT_URL" \
  -H "Content-Type: application/json" -H "X-Backup-Token: ${BACKUP_HEARTBEAT_TOKEN:-}" \
  -d "{\"kind\":\"$KIND\",\"ok\":$OK,\"size_bytes\":$SIZE,\"details\":\"$DETAILS\"}" || echo "Не вдалося надіслати heartbeat" >&2
exit 0
