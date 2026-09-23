require('dotenv').config();
const express = require('express');
const cors = require('cors');
const cron = require('node-cron');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

const { pool, initSchema, seedInitialAdmin, seedSuppliersFromEnv } = require('./db');
const { syncAllSuppliers } = require('./services/catalogSync');

const productsRouter = require('./routes/products');
const ordersRouter = require('./routes/orders');
const authRouter = require('./routes/auth');
const cartRouter = require('./routes/cart');
const deliveryRouter = require('./routes/delivery');
const accountRouter = require('./routes/account');
const configRouter = require('./routes/config');
const adminAuthRouter = require('./routes/adminAuth');
const adminUsersRouter = require('./routes/adminUsers');
const adminOrdersRouter = require('./routes/adminOrders');
const adminStatsRouter = require('./routes/adminStats');
const adminSuppliersRouter = require('./routes/adminSuppliers');
const adminSqlRouter = require('./routes/adminSql');
const adminLogsRouter = require('./routes/adminLogs');
const webhooksMydropRouter = require('./routes/webhooksMydrop');

const app = express();

app.use(helmet({ contentSecurityPolicy: false }));

const allowedOrigin = process.env.FRONTEND_ORIGIN;
app.use(cors(allowedOrigin ? { origin: allowedOrigin } : {}));

app.use(express.json({ limit: '1mb' }));

app.use('/api', rateLimit({ windowMs: 15 * 60 * 1000, max: 300, standardHeaders: true, legacyHeaders: false }));

const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 20, standardHeaders: true, legacyHeaders: false });
app.use('/api/auth/login', authLimiter);
app.use('/api/auth/register', authLimiter);
app.use('/api/auth/forgot-password', authLimiter);
app.use('/api/auth/reset-password', authLimiter);

app.get('/', (req, res) => res.json({ ok: true, service: 'OllShop backend' }));
app.get('/health', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

app.use('/api/products', productsRouter);
app.use('/api/orders', ordersRouter);
app.use('/api/auth', authRouter);
app.use('/api/cart', cartRouter);
app.use('/api/delivery', deliveryRouter);
app.use('/api/account', accountRouter);
app.use('/api/config', configRouter);
app.use('/api/admin/auth', adminAuthRouter);
app.use('/api/admin/users', adminUsersRouter);
app.use('/api/admin/orders', adminOrdersRouter);
app.use('/api/admin/stats', adminStatsRouter);
app.use('/api/admin/suppliers', adminSuppliersRouter);
app.use('/api/admin/sql', adminSqlRouter);
app.use('/api/admin/logs', adminLogsRouter);
app.use('/api/webhooks/mydrop', webhooksMydropRouter);

const PORT = process.env.PORT || 3000;

// Guards against two syncs running at once — a manual sync from the
// dashboard overlapping the hourly cron would otherwise have both
// processes deactivating each other's products mid-run.
let syncing = false;
async function runSync(label) {
  if (syncing) {
    console.warn(`[${label}] Попередня синхронізація ще триває — пропускаю цей запуск.`);
    return;
  }
  syncing = true;
  try {
    await syncAllSuppliers();
  } catch (err) {
    console.error(`[${label}] sync failed:`, err.message);
  } finally {
    syncing = false;
  }
}

async function start() {
  if (!process.env.JWT_SECRET) {
    console.error('FATAL: JWT_SECRET is not set. Registration and login will fail until you add it in Render → Environment.');
    process.exit(1);
  }
  if (!process.env.ADMIN_JWT_SECRET) {
    console.error('FATAL: ADMIN_JWT_SECRET is not set. Set it to a different long random string than JWT_SECRET.');
    process.exit(1);
  }

  await initSchema();
  console.log('Database schema ready.');

  await seedInitialAdmin();
  await seedSuppliersFromEnv();

  // Start serving straight away. The first catalogue pull runs in the
  // background: with several suppliers it can take minutes, and the API
  // shouldn't be unreachable while it does.
  app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

  runSync('boot');

  cron.schedule(process.env.FEED_SYNC_CRON || '0 * * * *', () => {
    console.log('[cron] running scheduled catalogue sync...');
    runSync('cron');
  });
}

start().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});

process.on('SIGTERM', async () => {
  await pool.end();
  process.exit(0);
});
