const express = require('express');
const { requireAdminAuth } = require('../middleware/adminAuth');
const { requireAdminRole } = require('../middleware/adminRole');
const { GROUPS, FIELD_BY_KEY, MAX_EXTRA, normalizeOwner, getOwner, saveOwner, buildSnapshot } = require('../services/ownerInfo');
const { getCurrentRow, publishVersion } = require('../services/termsService');
const { pool } = require('../db');

const router = express.Router();
router.use(requireAdminAuth, requireAdminRole);

// Поля, зміна яких означає ІНШУ сторону договору (інша юрособа / інший підприємець).
const IDENTITY_KEYS = ['legal_form', 'name', 'edrpou'];

function snapshotsEqual(a, b) {
  const av = (a && a.values) || {};
  const bv = (b && b.values) || {};
  const keys = new Set([...Object.keys(av), ...Object.keys(bv)]);
  for (const k of keys) if (av[k] !== bv[k]) return false;
  const ae = (a && a.extra) || [];
  const be = (b && b.extra) || [];
  if (ae.length !== be.length) return false;
  return ae.every((e, i) => e.label === be[i].label && e.value === be[i].value);
}

function changedLabels(oldSnap, newSnap) {
  const ov = (oldSnap && oldSnap.values) || {};
  const nv = newSnap.values || {};
  const labels = [];
  for (const k of new Set([...Object.keys(ov), ...Object.keys(nv)])) {
    // Підписи полів без дужок: «Код ЄДРПОУ (ТОВ, АТ) або РНОКПП (ФОП)» → «Код ЄДРПОУ або РНОКПП».
    if (ov[k] !== nv[k] && FIELD_BY_KEY[k]) labels.push((FIELD_BY_KEY[k].pubLabel || FIELD_BY_KEY[k].label).replace(/\s*\([^)]*\)/g, ''));
  }
  const oe = JSON.stringify((oldSnap && oldSnap.extra) || []);
  if (oe !== JSON.stringify(newSnap.extra || [])) labels.push('додаткові поля');
  return labels;
}

// GET /api/admin/owner — схема форми + поточні значення.
router.get('/', async (req, res) => {
  try {
    const owner = await getOwner();
    const current = await getCurrentRow();
    res.json({
      groups: GROUPS,
      maxExtra: MAX_EXTRA,
      value: owner.value,
      updated_at: owner.updated_at,
      updated_by: owner.updated_by,
      termsVersion: current ? current.version : null,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Не вдалося завантажити реквізити' });
  }
});

// PUT /api/admin/owner — зберегти реквізити.
// Тіло: { ...поля, extra: [...], republish_terms?: boolean }.
// Якщо змінились публічні реквізити, правила мають показувати нові дані:
//   republish_terms = true  → створюється нова редакція правил і покупці мають прийняти її ще раз;
//   republish_terms = false → реквізити оновлюються в чинній редакції без повторної згоди
//                             (для виправлення помилок і дрібних змін).
// Без параметра: нова редакція створюється лише якщо змінилась сама особа (форма, назва, код).
router.put('/', async (req, res) => {
  try {
    const { value, errors } = normalizeOwner(req.body);
    if (errors.length) return res.status(400).json({ error: errors.join('; '), errors });

    const before = await getOwner();
    const adminLabel = req.admin.email;
    await saveOwner(value, adminLabel);

    const newSnap = buildSnapshot(value);
    const current = await getCurrentRow();
    let termsChange = 'none';
    let version = current ? current.version : null;

    if (current && !snapshotsEqual(current.owner_snapshot, newSnap)) {
      const identityChanged = IDENTITY_KEYS.some((k) => before.value[k] !== value[k]);
      const republish = typeof req.body.republish_terms === 'boolean' ? req.body.republish_terms : identityChanged;

      if (republish) {
        const labels = changedLabels(current.owner_snapshot, newSnap);
        const created = await publishVersion({
          title: current.title,
          content: current.content,
          effectiveDate: null,
          changeSummary: `Змінено реквізити власника сайту${labels.length ? ` (${labels.join(', ')})` : ''}. Текст правил не змінювався.`,
          requireAcceptance: true,
          ownerSnapshot: newSnap,
          adminLabel,
        });
        termsChange = 'republished';
        version = created.version;
      } else {
        await pool.query('UPDATE terms_versions SET owner_snapshot = $2::jsonb WHERE id = $1', [current.id, JSON.stringify(newSnap)]);
        termsChange = 'updated_in_place';
      }
    }

    res.json({ ok: true, value, termsChange, termsVersion: version });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Не вдалося зберегти реквізити' });
  }
});

module.exports = router;
