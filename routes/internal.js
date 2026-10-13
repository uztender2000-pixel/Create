const express = require('express');
const crypto = require('crypto');
const { pool } = require('../db');
const { sendAlert } = require('../services/alerts');

const router = express.Router();

function tokenOk(given) {
  const expected = process.env.BACKUP_HEARTBEAT_TOKEN;
  if (!expected || !given) return false;
  const a = Buffer.from(String(given)); const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// POST /api/internal/backup-heartbeat — викликається GitHub Actions після резервної копії та після
// тестового відновлення (див. .github/workflows). Захищено секретом BACKUP_HEARTBEAT_TOKEN у заголовку
// X-Backup-Token; без змінної ендпоінт вимкнено. Тіло: { kind: 'backup'|'restore_test', ok, size_bytes?, details? }.
router.post('/backup-heartbeat', async (req, res) => {
  if (!process.env.BACKUP_HEARTBEAT_TOKEN) return res.status(404).json({ error: 'Not found' });
  if (!tokenOk(req.headers['x-backup-token'])) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const kind = req.body.kind === 'restore_test' ? 'restore_test' : 'backup';
    const ok = req.body.ok !== false;
    const value = {
      at: new Date().toISOString(), ok,
      size_bytes: Number.isFinite(Number(req.body.size_bytes)) ? Number(req.body.size_bytes) : null,
      details: String(req.body.details || '').slice(0, 500),
    };
    await pool.query(
      `INSERT INTO site_settings (key, value, updated_at, updated_by) VALUES ($1, $2::jsonb, now(), 'github-actions')
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now(), updated_by = 'github-actions'`,
      [kind === 'backup' ? 'last_backup' : 'last_restore_test', JSON.stringify(value)]
    );
    if (!ok) {
      sendAlert({ title: kind === 'backup' ? 'Резервна копія НЕ створена' : 'Тестове відновлення НЕ вдалося',
        text: value.details || 'Перевірте GitHub Actions.', dedupeKey: `backup-${kind}`, dedupeMinutes: 360 });
    }
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Не вдалося зберегти' });
  }
});

module.exports = router;
