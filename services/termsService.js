const { pool } = require('../db');
const { DEFAULT_TITLE, DEFAULT_CONTENT } = require('./termsDefault');
const { getOwner, buildSnapshot, snapshotRows } = require('./ownerInfo');

// ---------------------------------------------------------------------------
// Правила та умови: редакції зберігаються в terms_versions і НІКОЛИ не
// перезаписуються — кожна зміна тексту це нова редакція. Завдяки цьому для
// кожного покупця видно, яку саме редакцію він прийняв і коли (terms_acceptances).
//
// Текст пишеться в простому форматі (див. services/termsDefault.js) і на сервері
// перетворюється на HTML з обов'язковим екрануванням — адмін не може вставити
// скрипт на сторінки покупців.
// ---------------------------------------------------------------------------

const VERSION_COLS = `id, version, title, content, owner_snapshot, change_summary, require_acceptance,
  published_by, created_at, to_char(effective_date, 'YYYY-MM-DD') AS effective_date`;

const LIMITS = { title: 300, content: 200000, summary: 2000 };

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// **жирний** — після екранування (зірочки екрануванням не змінюються).
function bold(escaped) {
  return escaped.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
}

function placeholderSpan(text) {
  return `<span class="ph">${esc(text)}</span>`;
}

function renderTerms(content, snapshot) {
  const values = (snapshot && snapshot.values) || {};
  const lines = String(content || '').replace(/\r\n/g, '\n').split('\n');
  const toc = [];
  let html = '';
  let inList = false;
  let sec = 0;

  const inline = (raw) => {
    let s = bold(esc(raw));
    // {{owner.ключ}} — підстановка реквізиту власника з зрізу редакції.
    s = s.replace(/\{\{owner\.([a-z_]+)\}\}/g, (_, key) => (
      values[key] ? esc(values[key]) : placeholderSpan('[вкажіть у налаштуваннях власника]')
    ));
    return s;
  };
  const closeList = () => { if (inList) { html += '</ul>'; inList = false; } };

  for (const line of lines) {
    const t = line.trim();
    if (!t) { closeList(); continue; }

    if (t.startsWith('- ')) {
      if (!inList) { html += '<ul>'; inList = true; }
      html += `<li>${inline(t.slice(2))}</li>`;
      continue;
    }
    closeList();

    if (t.startsWith('## ')) {
      const title = t.slice(3).trim();
      sec += 1;
      toc.push({ id: `s${sec}`, title });
      html += `<h2 id="s${sec}">${inline(title)}</h2>`;
    } else if (t.startsWith('> ')) {
      html += `<div class="lead">${inline(t.slice(2))}</div>`;
    } else if (t === '{{owner_block}}') {
      const rows = snapshotRows(snapshot);
      html += '<div class="owner">' + (rows.length
        ? rows.map((r) => `<div><span class="k">${esc(r.label)}:</span> ${r.value ? `<span>${esc(r.value)}</span>` : placeholderSpan(r.placeholder)}</div>`).join('')
        : `<div>${placeholderSpan('[реквізити власника ще не заповнені]')}</div>`) + '</div>';
    } else {
      html += `<p>${inline(t)}</p>`;
    }
  }
  closeList();
  return { html, toc };
}

function publicMeta(row) {
  return {
    version: row.version,
    title: row.title,
    effective_date: row.effective_date,
    change_summary: row.change_summary || null,
  };
}

function withHtml(row) {
  const { html, toc } = renderTerms(row.content, row.owner_snapshot);
  return { ...publicMeta(row), html, toc };
}

async function getCurrentRow() {
  const { rows } = await pool.query(`SELECT ${VERSION_COLS} FROM terms_versions ORDER BY id DESC LIMIT 1`);
  return rows[0] || null;
}

async function getRowByVersion(version) {
  const { rows } = await pool.query(`SELECT ${VERSION_COLS} FROM terms_versions WHERE version = $1`, [version]);
  return rows[0] || null;
}

async function getRowById(id) {
  const { rows } = await pool.query(`SELECT ${VERSION_COLS} FROM terms_versions WHERE id = $1`, [id]);
  return rows[0] || null;
}

// Чи має користувач (ще) прийняти правила. Потрібно, якщо він не приймав жодної
// редакції або прийняв редакцію старішу за останню, що вимагає повторної згоди.
async function getTermsStatus(userId) {
  const { rows } = await pool.query(
    `SELECT u.terms_version, u.terms_accepted_at, av.id AS accepted_id,
            (SELECT id FROM terms_versions WHERE require_acceptance ORDER BY id DESC LIMIT 1) AS required_id,
            (SELECT version FROM terms_versions ORDER BY id DESC LIMIT 1) AS current_version
       FROM users u
       LEFT JOIN terms_versions av ON av.version = u.terms_version
      WHERE u.id = $1`,
    [userId]
  );
  if (!rows.length) return null;
  const r = rows[0];
  const needsAcceptance = r.required_id != null && (r.accepted_id == null || r.accepted_id < r.required_id);
  return {
    needsAcceptance,
    acceptedVersion: r.accepted_id != null ? r.terms_version : null,
    acceptedAt: r.accepted_id != null ? r.terms_accepted_at : null,
    currentVersion: r.current_version,
  };
}

// Фіксує згоду користувача з поточною редакцією.
async function recordAcceptance(userId, row, req) {
  const ip = req && (req.ip || (req.headers && req.headers['x-forwarded-for'])) || null;
  const ua = req && req.headers && req.headers['user-agent'] ? String(req.headers['user-agent']).slice(0, 400) : null;
  await pool.query('UPDATE users SET terms_accepted_at = now(), terms_version = $2 WHERE id = $1', [userId, row.version]);
  await pool.query(
    'INSERT INTO terms_acceptances (user_id, terms_version_id, version, ip, user_agent) VALUES ($1, $2, $3, $4, $5)',
    [userId, row.id, row.version, ip ? String(ip).slice(0, 100) : null, ua]
  );
}

// Нова редакція. Повертає створений рядок.
async function publishVersion({ title, content, effectiveDate, changeSummary, requireAcceptance, ownerSnapshot, adminLabel }) {
  const { rows: baseRows } = await pool.query(`SELECT to_char(now() AT TIME ZONE 'Europe/Kyiv', 'YYYY-MM-DD') AS d`);
  const base = baseRows[0].d;
  const { rows: same } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM terms_versions WHERE version = $1 OR version LIKE $1 || '-%'`, [base]
  );
  const version = same[0].n ? `${base}-${same[0].n + 1}` : base;

  const { rows } = await pool.query(
    `INSERT INTO terms_versions (version, title, content, owner_snapshot, effective_date, change_summary, require_acceptance, published_by)
     VALUES ($1, $2, $3, $4::jsonb, COALESCE($5::date, (now() AT TIME ZONE 'Europe/Kyiv')::date), $6, $7, $8)
     RETURNING ${VERSION_COLS}`,
    [version, title, content, JSON.stringify(ownerSnapshot || { values: {}, extra: [] }),
      effectiveDate || null, changeSummary || null, requireAcceptance !== false, adminLabel || null]
  );
  return rows[0];
}

// Перший запуск: кладемо в базу початкову редакцію і переносимо старі згоди
// (users.terms_version) у журнал terms_acceptances.
async function ensureInitialTerms() {
  const { rows } = await pool.query('SELECT COUNT(*)::int AS n FROM terms_versions');
  if (rows[0].n === 0) {
    const owner = await getOwner();
    await pool.query(
      `INSERT INTO terms_versions (version, title, content, owner_snapshot, effective_date, change_summary, require_acceptance, published_by)
       VALUES ('2026-10-09', $1, $2, $3::jsonb, DATE '2026-10-09', NULL, true, 'system')`,
      [DEFAULT_TITLE, DEFAULT_CONTENT, JSON.stringify(buildSnapshot(owner.value))]
    );
    console.log('[terms] Створено початкову редакцію правил та умов (2026-10-09).');
  }

  const res = await pool.query(
    `INSERT INTO terms_acceptances (user_id, terms_version_id, version, accepted_at)
     SELECT u.id, tv.id, tv.version, u.terms_accepted_at
       FROM users u
       JOIN terms_versions tv ON tv.version = u.terms_version
      WHERE u.terms_accepted_at IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM terms_acceptances a WHERE a.user_id = u.id)`
  );
  if (res.rowCount) console.log(`[terms] Перенесено ${res.rowCount} наявних згод у журнал.`);
}

module.exports = {
  LIMITS, esc, renderTerms, publicMeta, withHtml,
  getCurrentRow, getRowByVersion, getRowById,
  getTermsStatus, recordAcceptance, publishVersion, ensureInitialTerms,
};
