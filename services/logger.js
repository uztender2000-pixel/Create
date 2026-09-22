const { pool } = require('../db');

// =====================================================================
// A single place to record "something went wrong" events so the admin
// panel's Логи page has something to read. This never throws — logging
// a problem must not create a second problem — and it always still
// prints to the console too, so Render's own log stream keeps working
// exactly as it did before.
// =====================================================================

// source: 'sync' | 'order' | 'webhook'
// level: 'error' | 'warn'
async function logEvent({ level = 'error', source, supplierId = null, message, detail = null }) {
  const line = `[${source}]${supplierId ? ` supplier=${supplierId}` : ''} ${message}`;
  if (level === 'error') console.error(line, detail || '');
  else console.warn(line, detail || '');

  try {
    await pool.query(
      `INSERT INTO event_log (level, source, supplier_id, message, detail)
       VALUES ($1, $2, $3, $4, $5)`,
      [level, source, supplierId, String(message).slice(0, 2000), detail ? String(detail).slice(0, 4000) : null]
    );
  } catch (err) {
    // The DB itself being unreachable is exactly the kind of situation
    // this logger can't rely on the DB to record — console output above
    // is already the fallback.
    console.error('[logger] failed to write event_log:', err.message);
  }
}

module.exports = { logEvent };
