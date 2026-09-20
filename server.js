require('dotenv').config();
const express = require('express');
const cors = require('cors');
const cron = require('node-cron');

const { pool, initSchema } = require('./db');
const { syncAllFeeds } = require('./services/feedImporter');
const productsRouter = require('./routes/products');
const ordersRouter = require('./routes/orders');
const authRouter = require('./routes/auth');
const cartRouter = require('./routes/cart');
const deliveryRouter = require('./routes/delivery');

const app = express();
app.use(cors());
app.use(express.json());

// Simple health check — this is also the endpoint UptimeRobot should ping
// every 5 minutes to keep the Render free-tier instance awake.
app.get('/health', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

app.use('/api/products', productsRouter);
app.use('/api/orders', ordersRouter);
app.use('/api/auth', authRouter);
app.use('/api/cart', cartRouter);
app.use('/api/delivery', deliveryRouter);

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
