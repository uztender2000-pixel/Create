require('dotenv').config();
const express = require('express');
const cors = require('cors');
const cron = require('node-cron');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

const { pool, initSchema } = require('./db');
const { syncAllFeeds } = require('./services/feedImporter');
const productsRouter = require('./routes/products');
const ordersRouter = require('./routes/orders');
const authRouter = require('./routes/auth');
const cartRouter = require('./routes/cart');
const deliveryRouter = require('./routes/delivery');
const accountRouter = require('./routes/account');
const configRouter = require('./routes/config');

const app = express();

// Sets a standard set of protective HTTP headers (no sniffing, no
// clickjacking via frames, hides tech stack fingerprinting, etc.). Disabled
// CSP here since this is a pure JSON API, not serving HTML.
app.use(helmet({ contentSecurityPolicy: false }));

// Only your own storefront origin may call this API from a browser. Set
// FRONTEND_ORIGIN in Render to your Static Site's URL once you know it —
// until then this falls back to allowing any origin, so nothing breaks
// during setup.
const allowedOrigin = process.env.FRONTEND_ORIGIN;
app.use(cors(allowedOrigin ? { origin: allowedOrigin } : {}));

app.use(express.json({ limit: '1mb' })); // caps request body size against abuse

// General API rate limit: 300 requests per 15 minutes per IP — generous
// for real shoppers, restrictive against scripted abuse/scraping.
app.use('/api', rateLimit({ windowMs: 15 * 60 * 1000, max: 300, standardHeaders: true, legacyHeaders: false }));

// Tighter limit specifically on auth endpoints — the ones worth protecting
// most against brute-force password guessing or mass fake signups.
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 20, standardHeaders: true, legacyHeaders: false });
app.use('/api/auth/login', authLimiter);
app.use('/api/auth/register', authLimiter);

// Simple health check — this is also the endpoint UptimeRobot should ping
// every 5 minutes to keep the Render free-tier instance awake.
// UptimeRobot's monitor is pointed at the root URL, not /health — give it
// a 200 here too, so pings against either path keep the service awake.
app.get('/', (req, res) => res.json({ ok: true, service: 'OllShop backend' }));
app.get('/health', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

app.use('/api/products', productsRouter);
app.use('/api/orders', ordersRouter);
app.use('/api/auth', authRouter);
app.use('/api/cart', cartRouter);
app.use('/api/delivery', deliveryRouter);
app.use('/api/account', accountRouter);
app.use('/api/config', configRouter);

const PORT = process.env.PORT || 3000;

async function start() {
  if (!process.env.JWT_SECRET) {
    console.error('FATAL: JWT_SECRET is not set. Registration and login will fail until you add it in Render → Environment.');
    process.exit(1);
  }

  await initSchema();
  console.log('Database schema ready.');

  // Pull the feeds once immediately on boot, so the catalog isn't empty
  // while waiting for the first scheduled run.
  await syncAllFeeds();

  // Then keep it fresh on the schedule set in .env (default: hourly).
  cron.schedule(process.env.FEED_SYNC_CRON || '0 * * * *', () => {
    console.log('[cron] running scheduled feed sync...');
    syncAllFeeds();
  });

  app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
}

start().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});

// Graceful shutdown so Render's deploys don't leave dangling DB connections.
process.on('SIGTERM', async () => {
  await pool.end();
  process.exit(0);
});
