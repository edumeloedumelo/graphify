import 'dotenv/config';
import express from 'express';

import { routeWebhook } from './router.js';
import { startScheduler } from './scheduler.js';
import { runSync, isSyncRunning, lastSyncInfo } from './sync.js';
import { countCases } from './snapshot.js';
import { getConfig } from './config.js';
import * as sheets from './sheets.js';

const app = express();
const PORT = Number(process.env.PORT) || 3000;

app.use(express.json({ limit: '25mb' }));
app.use(express.urlencoded({ extended: true, limit: '25mb' }));

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    bot: getConfig().botName,
    uptimeSeconds: Math.round(process.uptime()),
    casesTracked: countCases(),
    syncRunning: isSyncRunning(),
    lastSync: lastSyncInfo(),
    sheets: sheets.sheetsEnabled(),
  });
});

app.post('/webhook', async (req, res) => {
  // responde na hora: o UltraMsg reenvia o evento se a resposta demorar
  res.status(200).json({ received: true });

  try {
    const result = await routeWebhook(req.body);
    if (result?.handled) console.log('[webhook]', result);
  } catch (err) {
    console.error('[webhook] erro:', err);
  }
});

// dispara uma varredura manualmente (util para cron externo)
app.post('/sync', async (req, res) => {
  const secret = process.env.SYNC_SECRET;
  if (secret) {
    const provided = req.get('x-sync-secret') || req.query.secret || req.body?.secret;
    if (provided !== secret) return res.status(401).json({ error: 'segredo invalido' });
  }

  if (isSyncRunning()) return res.status(409).json({ error: 'sincronizacao ja em andamento' });

  res.status(202).json({ started: true });
  runSync({ trigger: 'http', notifyChatId: req.body?.chatId || '' }).catch((err) =>
    console.error('[/sync] erro:', err),
  );
  return undefined;
});

app.get('/status', (_req, res) => {
  res.json({ lastSync: lastSyncInfo(), casesTracked: countCases(), syncRunning: isSyncRunning() });
});

app.use((req, res) => res.status(404).json({ error: 'not found', path: req.path }));

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[index] ${getConfig().botName} ouvindo na porta ${PORT}`);
  console.log(`[index] webhook: POST /webhook | health: GET /health`);
  startScheduler();
});

process.on('unhandledRejection', (err) => console.error('[index] unhandledRejection:', err));
process.on('uncaughtException', (err) => console.error('[index] uncaughtException:', err));
