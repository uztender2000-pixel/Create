#!/usr/bin/env node
'use strict';

// CLI для перевірки інтеграції з SendPulse.
//
//   node scripts/sendpulse-test.js --verify
//   node scripts/sendpulse-test.js --to you@example.com
//   node scripts/sendpulse-test.js --to you@example.com --subject "Привіт" --text "Тест" --html "<p>Тест</p>"
//
// Змінні беруться з середовища або з файлу .env у корені проєкту.
// Код завершення: 0 — успіх, 1 — помилка SendPulse, 2 — неправильні аргументи/конфігурація.

try { require('dotenv').config(); } catch (_) { /* dotenv необов'язковий */ }
const { sendEmail, verifyAuth, SendPulseError } = require('../services/sendpulseClient');

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) args[key] = true;
    else { args[key] = next; i += 1; }
  }
  return args;
}

const USAGE = `Використання:
  node scripts/sendpulse-test.js --verify
  node scripts/sendpulse-test.js --to <email> [--subject "..."] [--text "..."] [--html "..."] [--from <email>] [--from-name "..."]`;

function fail(err) {
  if (err instanceof SendPulseError) {
    console.error(`✗ [${err.code}] ${err.message}`);
    if (err.code === 'INVALID_SENDER') {
      console.error('  Підказка: на безкоштовному/платному тарифі SENDPULSE_API_FROM_EMAIL має бути вашим підтвердженим відправником. devtest@sendpulseemail.com працює лише на тестовому тарифі.');
    }
    if (err.code === 'RATE_LIMITED') {
      console.error('  Підказка: на тестовому тарифі діють ліміти на кількість листів (загальний і погодинний) — зачекайте або перейдіть на свій домен.');
    }
    return err.code === 'CONFIG' || err.code === 'VALIDATION' ? 2 : 1;
  }
  console.error('✗ Несподівана помилка:', err && err.message ? err.message : err);
  return 1;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.verify) {
    const { user } = await verifyAuth();
    console.log('✓ Авторизація успішна.');
    const brief = ['id', 'email', 'name', 'first_name', 'last_name'].filter((k) => user && user[k] !== undefined);
    brief.forEach((k) => console.log(`  ${k}: ${user[k]}`));
    return 0;
  }

  if (!args.to || args.to === true) {
    console.error(USAGE);
    return 2;
  }

  const subject = typeof args.subject === 'string' ? args.subject : 'Тестовий лист SendPulse';
  const text = typeof args.text === 'string' ? args.text : 'Привіт! Це тестовий лист з інтеграції SendPulse.';
  const html = typeof args.html === 'string' ? args.html : `<p>${text.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</p>`;

  const result = await sendEmail({
    to: args.to,
    subject,
    text,
    html,
    from: typeof args.from === 'string' ? args.from : undefined,
    fromName: typeof args['from-name'] === 'string' ? args['from-name'] : undefined,
  });
  console.log(`✓ Лист прийнято SendPulse${result.id ? ` (id: ${result.id})` : ''}.`);
  console.log('  Якщо ви на тестовому тарифі: відправник і тема будуть змінені SendPulse — це очікувано (див. README-SENDPULSE.md).');
  return 0;
}

main().then((code) => process.exit(code)).catch((err) => process.exit(fail(err)));
