const { pool } = require('../db');

// ---------------------------------------------------------------------------
// Реквізити власника сайту (ТОВ, АТ, ФОП тощо). Зберігаються в site_settings
// під ключем 'owner'. Схема полів описана тут один раз: адмінка будує форму з неї
// (GET /api/admin/owner), а правила та умови беруть із неї публічні реквізити.
//
// pub: true  — поле показується покупцям у розділі «Реквізити Власника» правил;
// pub: false — тільки для внутрішнього користування (бачить лише адмінка).
// required: true — у правилах показується підказка «[вкажіть…]», якщо порожнє.
// ---------------------------------------------------------------------------

const LEGAL_FORMS = ['ТОВ', 'ПрАТ', 'АТ', 'ФОП', 'ПП', 'ДП', 'ГО / ВГО', 'Інше'];

const TAX_SYSTEM_HINTS = [
  'Загальна система оподаткування',
  'Єдиний податок, 1 група',
  'Єдиний податок, 2 група',
  'Єдиний податок, 3 група (5%)',
  'Єдиний податок, 3 група (3% + ПДВ)',
];

const GROUPS = [
  {
    id: 'general', title: 'Загальні відомості',
    fields: [
      { key: 'legal_form', label: 'Організаційно-правова форма', type: 'select', options: LEGAL_FORMS, pub: true },
      { key: 'name', label: 'Повне найменування (для ФОП — ПІБ підприємця)', pubLabel: 'Власник Сайту', type: 'text', pub: true, required: true, placeholder: 'ТОВ «Назва» / ФОП Петренко Іван Іванович' },
      { key: 'short_name', label: 'Скорочене найменування', type: 'text', pub: true },
      { key: 'edrpou', label: 'Код ЄДРПОУ (ТОВ, АТ) або РНОКПП (ФОП)', pubLabel: 'Код ЄДРПОУ / РНОКПП', type: 'text', pub: true, required: true, placeholder: '8 або 10 цифр' },
      { key: 'registration_number', label: 'Номер запису в ЄДР', type: 'text', pub: true },
      { key: 'registration_date', label: 'Дата державної реєстрації', type: 'date', pub: true },
      { key: 'kved', label: 'Основний КВЕД', type: 'text', pub: true, placeholder: '47.91 Роздрібна торгівля, що здійснюється фірмами поштового замовлення' },
      { key: 'director_position', label: 'Посада керівника', type: 'text', pub: true, placeholder: 'Директор' },
      { key: 'director_name', label: 'ПІБ керівника / представника', type: 'text', pub: true },
      { key: 'acts_on_basis', label: 'Діє на підставі', type: 'text', pub: true, placeholder: 'Статуту / Витягу з ЄДР' },
    ],
  },
  {
    id: 'addresses', title: 'Адреси',
    fields: [
      { key: 'legal_address', label: 'Юридична адреса', type: 'text', pub: true, required: true },
      { key: 'actual_address', label: 'Фактична адреса (якщо відрізняється)', pubLabel: 'Фактична адреса', type: 'text', pub: true },
      { key: 'postal_address', label: 'Адреса для листування', type: 'text', pub: true },
    ],
  },
  {
    id: 'contacts', title: 'Контакти',
    fields: [
      { key: 'email', label: 'Електронна пошта для звернень', pubLabel: 'Електронна пошта', type: 'email', pub: true, required: true },
      { key: 'phone', label: 'Телефон', type: 'tel', pub: true, required: true },
      { key: 'phone_extra', label: 'Додатковий телефон', type: 'tel', pub: true },
      { key: 'website', label: 'Адреса сайту', type: 'text', pub: true, placeholder: 'https://example.com' },
      { key: 'work_hours', label: 'Графік роботи', type: 'text', pub: true },
      { key: 'contact_person', label: 'Контактна особа (внутрішнє)', type: 'text', pub: false },
    ],
  },
  {
    id: 'bank', title: 'Банківські реквізити',
    fields: [
      { key: 'bank_name', label: 'Назва банку', type: 'text', pub: true },
      { key: 'iban', label: 'Рахунок IBAN', type: 'text', pub: true, placeholder: 'UA + 27 цифр' },
      { key: 'mfo', label: 'МФО банку', type: 'text', pub: true, placeholder: '6 цифр' },
      { key: 'swift', label: 'SWIFT / BIC', type: 'text', pub: true },
      { key: 'bank_notes', label: 'Призначення платежу / примітка до рахунку', pubLabel: 'Примітка до рахунку', type: 'text', pub: true },
    ],
  },
  {
    id: 'tax', title: 'Податкова інформація',
    fields: [
      { key: 'tax_system', label: 'Система оподаткування', type: 'text', pub: true, suggestions: TAX_SYSTEM_HINTS },
      { key: 'vat_payer', label: 'Платник ПДВ', type: 'bool', pub: true },
      { key: 'ipn', label: 'ІПН платника ПДВ', type: 'text', pub: true, placeholder: '10–12 цифр' },
      { key: 'vat_certificate', label: 'Номер свідоцтва платника ПДВ', type: 'text', pub: true },
      { key: 'tax_office', label: 'Контролюючий орган (ГУ ДПС), де перебуває на обліку', pubLabel: 'Перебуває на обліку в ДПС', type: 'text', pub: true },
      { key: 'tax_notes', label: 'Інші податкові відомості', type: 'textarea', pub: true },
    ],
  },
  {
    id: 'other', title: 'Ліцензії та інше',
    fields: [
      { key: 'licenses', label: 'Ліцензії, дозволи, реєстраційні документи', type: 'textarea', pub: true },
      { key: 'internal_notes', label: 'Внутрішні нотатки (не показуються покупцям)', type: 'textarea', pub: false },
    ],
  },
];

const FIELDS = GROUPS.flatMap((g) => g.fields);
const FIELD_BY_KEY = Object.fromEntries(FIELDS.map((f) => [f.key, f]));

const MAX_LEN = { text: 500, email: 200, tel: 100, date: 20, select: 100, textarea: 3000 };
const MAX_EXTRA = 30;

function emptyOwner() {
  const o = { extra: [] };
  for (const f of FIELDS) o[f.key] = f.type === 'bool' ? false : '';
  return o;
}

// Приводить довільний вхід до чистого об'єкта за схемою. Повертає { value, errors }.
function normalizeOwner(input) {
  const src = input && typeof input === 'object' ? input : {};
  const out = emptyOwner();
  const errors = [];

  for (const f of FIELDS) {
    const raw = src[f.key];
    if (f.type === 'bool') { out[f.key] = raw === true || raw === 'true'; continue; }
    let v = raw == null ? '' : String(raw).replace(/\r\n/g, '\n').trim();
    if (f.type !== 'textarea') v = v.replace(/\s*\n\s*/g, ' ');
    if (v.length > (MAX_LEN[f.type] || 500)) {
      errors.push(`«${f.label}»: занадто довге значення`);
      v = v.slice(0, MAX_LEN[f.type] || 500);
    }
    out[f.key] = v;
  }

  // Формати, які легко перевірити.
  const digits = (s) => String(s).replace(/\s+/g, '');
  if (out.edrpou) {
    out.edrpou = digits(out.edrpou);
    if (!/^(\d{8}|\d{10})$/.test(out.edrpou)) errors.push('Код ЄДРПОУ/РНОКПП має містити 8 або 10 цифр');
  }
  if (out.iban) {
    out.iban = digits(out.iban).toUpperCase();
    if (!/^UA\d{27}$/.test(out.iban)) errors.push('IBAN має бути у форматі UA + 27 цифр');
  }
  if (out.mfo) {
    out.mfo = digits(out.mfo);
    if (!/^\d{6}$/.test(out.mfo)) errors.push('МФО має містити 6 цифр');
  }
  if (out.ipn) {
    out.ipn = digits(out.ipn);
    if (!/^\d{10,12}$/.test(out.ipn)) errors.push('ІПН має містити 10–12 цифр');
  }
  if (out.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(out.email)) errors.push('Некоректна електронна пошта');
  if (out.registration_date && !/^\d{4}-\d{2}-\d{2}$/.test(out.registration_date)) errors.push('Некоректна дата реєстрації');
  if (out.legal_form && !LEGAL_FORMS.includes(out.legal_form)) errors.push('Невідома організаційно-правова форма');

  // Довільні додаткові поля: [{ label, value, public }]
  const extra = Array.isArray(src.extra) ? src.extra : [];
  if (extra.length > MAX_EXTRA) errors.push(`Додаткових полів може бути не більше ${MAX_EXTRA}`);
  out.extra = extra.slice(0, MAX_EXTRA)
    .map((e) => ({
      label: String((e && e.label) ?? '').trim().slice(0, 200),
      value: String((e && e.value) ?? '').trim().slice(0, 1000),
      public: !(e && (e.public === false || e.public === 'false')),
    }))
    .filter((e) => e.label || e.value);
  if (out.extra.some((e) => !e.label)) errors.push('У додаткових полях кожне значення має мати назву');

  return { value: out, errors };
}

async function getOwner() {
  const { rows } = await pool.query(`SELECT value, updated_at, updated_by FROM site_settings WHERE key = 'owner'`);
  if (!rows.length) return { value: emptyOwner(), updated_at: null, updated_by: null };
  // normalizeOwner без помилок: старі дані могли бути збережені до зміни схеми.
  return { value: normalizeOwner(rows[0].value).value, updated_at: rows[0].updated_at, updated_by: rows[0].updated_by };
}

async function saveOwner(value, adminLabel) {
  await pool.query(
    `INSERT INTO site_settings (key, value, updated_at, updated_by)
     VALUES ('owner', $1::jsonb, now(), $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now(), updated_by = EXCLUDED.updated_by`,
    [JSON.stringify(value), adminLabel || null]
  );
}

// Зріз ПУБЛІЧНИХ реквізитів, який зберігається разом з кожною редакцією правил:
// так стара редакція завжди показує реквізити, які діяли на момент її публікації,
// а внутрішні поля (нотатки, контактна особа) ніколи не потрапляють покупцям.
function buildSnapshot(owner) {
  const values = {};
  for (const f of FIELDS) {
    if (!f.pub) continue;
    const v = owner[f.key];
    if (f.type === 'bool') { values[f.key] = v ? 'Так' : 'Ні'; continue; }
    if (v) values[f.key] = f.type === 'date' ? formatDate(v) : v;
  }
  const extra = (owner.extra || []).filter((e) => e.public && e.label && e.value).map((e) => ({ label: e.label, value: e.value }));
  return { values, extra };
}

function formatDate(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || '');
  return m ? `${m[3]}.${m[2]}.${m[1]}` : iso;
}

// Рядки для блоку «Реквізити Власника»: [{ label, value, placeholder }]
function snapshotRows(snapshot) {
  const values = (snapshot && snapshot.values) || {};
  const rows = [];
  for (const g of GROUPS) {
    for (const f of g.fields) {
      if (!f.pub) continue;
      const v = values[f.key];
      // ПДВ показуємо лише якщо воно має сенс: або «Так», або вже є інші податкові дані.
      if (f.key === 'vat_payer') {
        const hasTax = values.tax_system || values.ipn || values.vat_certificate;
        if (v === 'Так' || (v === 'Ні' && hasTax)) rows.push({ label: f.pubLabel || f.label, value: v });
        continue;
      }
      const label = f.pubLabel || f.label;
      if (v) rows.push({ label, value: v });
      else if (f.required) rows.push({ label, value: '', placeholder: `[вкажіть: ${label.toLowerCase()}]` });
    }
  }
  for (const e of (snapshot && snapshot.extra) || []) rows.push({ label: e.label, value: e.value });
  return rows;
}

module.exports = {
  GROUPS, FIELDS, FIELD_BY_KEY, LEGAL_FORMS, MAX_EXTRA,
  emptyOwner, normalizeOwner, getOwner, saveOwner, buildSnapshot, snapshotRows,
};
