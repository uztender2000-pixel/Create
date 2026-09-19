# Dropshipping Backend (MVP)

Мінімальний бекенд: тягне твої фіди з dropshipping.ua, зберігає товари й замовлення
в PostgreSQL, віддає простий API для сайту, і шле тобі в Telegram сповіщення про
нові замовлення.

## Що вже вміє

- Автоматичний імпорт товарів із твоїх особистих XML-фідів (раз на годину, налаштовується)
- API: `GET /api/products`, `GET /api/products/:id`, `POST /api/orders`
- Telegram-сповіщення про нове замовлення (опційно)
- `GET /health` — для UptimeRobot, щоб Render free-tier не засинав

## Локальний запуск

```bash
npm install
cp .env.example .env
# відредагуй .env — встав свій DATABASE_URL
npm run dev
```

Потрібна локальна чи хмарна PostgreSQL для тесту. Найпростіше — одразу створити
безкоштовну базу на Render (див. нижче) і використати її URL навіть локально.

## Деплой на Render

1. Заведи новий **Web Service** на render.com, підключи цей GitHub-репозиторій
2. Build command: `npm install`, Start command: `npm start`
3. Заведи окремо безкоштовний **PostgreSQL** на Render — скопіюй "Internal Database URL"
4. У розділі Environment Variables Web Service додай усі змінні з `.env.example`,
   з `DATABASE_URL` від щойно створеної бази
5. Деплой — Render сам підхопить зміни при кожному push у гілку

## Після деплою

1. Перевір `https://твій-домен.onrender.com/health` — має віддати `{"ok":true,...}`
2. Перевір `https://твій-домен.onrender.com/api/products` — мають з'явитись товари з фіду
   (може знадобитись до хвилини на перший синк при старті)
3. Постав своїм 3 фіналістам роздрібну ціну і позначку featured:
   ```bash
   curl -X PATCH https://твій-домен.onrender.com/api/products/ІД_ТОВАРУ/retail-price \
     -H "Content-Type: application/json" \
     -d '{"retail_price": 379, "featured": true}'
   ```
   (ІД товару бери з поля `id` у відповіді `/api/products`)
4. Підключи UptimeRobot: монітор типу HTTP(s) на `/health`, інтервал 5 хв

## Telegram-сповіщення (опційно, але дуже рекомендую)

1. Напиши [@BotFather](https://t.me/BotFather) в Telegram → `/newbot` → отримаєш токен
2. Напиши своєму новому боту будь-що, потім відкрий
   `https://api.telegram.org/bot<ТОКЕН>/getUpdates` і знайди своє `chat.id`
3. Встав обидва значення в `TELEGRAM_BOT_TOKEN` і `TELEGRAM_CHAT_ID` на Render

## Важливе застереження з безпеки (перед реальним запуском)

`GET /api/orders` і `PATCH /api/orders/:id` зараз відкриті без авторизації —
це нормально на етапі розробки, але перед тим як пускати реальний трафік,
додай хоча б простий API-ключ у заголовку запиту, інакше будь-хто зможе
переглянути список замовлень клієнтів.

## Наступні кроки (не в цій версії)

- Автоматичне оформлення замовлення постачальнику через API dropshipping.ua
  (зараз це робиш вручну в їхньому кабінеті за сповіщенням з Telegram)
- Фронтенд-каталог/лендінг, що звертається до цього API
- Авторизація для адмін-ендпоінтів
