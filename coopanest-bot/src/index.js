import 'dotenv/config';
import express from 'express';

import { startScheduler } from './scheduler.js';
import { runSync, isSyncRunning, lastSyncInfo } from './sync.js';
import { loadSnapshot, countCases } from './snapshot.js';
import { computeSalary } from './salary.js';
import { getConfig } from './config.js';
import * as sheets from './sheets.js';

const app = express();
const PORT = Number(process.env.PORT) || 3000;

app.use(express.json({ limit: '5mb' }));

// resultado da conferência da planilha feita no boot
let sheetsCheck = { ok: false, motivo: 'ainda nao conferido' };

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    bot: getConfig().botName,
    uptimeSeconds: Math.round(process.uptime()),
    casesTracked: countCases(),
    syncRunning: isSyncRunning(),
    lastSync: lastSyncInfo(),
    planilha: sheetsCheck,
    portal: {
      urlConfigurada: Boolean(process.env.COOPANEST_LOGIN_URL),
      credenciais: Boolean(process.env.COOPANEST_USER && process.env.COOPANEST_PASS),
    },
    anthropic: Boolean(process.env.ANTHROPIC_API_KEY),
  });
});

app.get('/status', (_req, res) => {
  res.json({
    lastSync: lastSyncInfo(),
    casesTracked: countCases(),
    syncRunning: isSyncRunning(),
    sheetUrl: sheets.sheetUrl(),
  });
});

app.get('/salario', (_req, res) => {
  const summary = computeSalary(Object.values(loadSnapshot()));
  res.json({
    beneficiario: getConfig().salary?.beneficiary || 'Sara',
    meses: summary.months.map((month) => ({
      mes: month.month,
      cirurgias: month.count,
      bruto: round2(month.gross),
      imposto: round2(month.tax),
      liquido: round2(month.net),
      salario: round2(month.salary),
    })),
    total: round2(summary.totals.salary),
  });
});

// dispara uma varredura fora do horário (útil para cron externo ou teste manual)
app.post('/sync', (req, res) => {
  const secret = process.env.SYNC_SECRET;
  if (secret) {
    const provided = req.get('x-sync-secret') || req.query.secret || req.body?.secret;
    if (provided !== secret) return res.status(401).json({ error: 'segredo invalido' });
  }

  if (isSyncRunning()) return res.status(409).json({ error: 'sincronizacao ja em andamento' });

  res.status(202).json({ started: true });
  runSync({ trigger: 'http' }).catch((err) => console.error('[/sync] erro:', err));
  return undefined;
});

app.use((req, res) => res.status(404).json({ error: 'not found', path: req.path }));

function round2(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

app.listen(PORT, '0.0.0.0', async () => {
  console.log(`[index] ${getConfig().botName} ouvindo na porta ${PORT}`);
  console.log('[index] GET /health | GET /status | GET /salario | POST /sync');

  sheetsCheck = await sheets.verifyAccess();
  if (sheetsCheck.ok) {
    console.log(`[index] planilha OK: "${sheetsCheck.planilha}" (abas: ${sheetsCheck.abas.join(', ') || 'nenhuma ainda'})`);
  } else {
    console.error(`[index] PLANILHA INDISPONIVEL: ${sheetsCheck.motivo}`);
  }

  if (!process.env.ANTHROPIC_API_KEY) console.error('[index] ANTHROPIC_API_KEY nao configurada');
  if (!process.env.COOPANEST_USER || !process.env.COOPANEST_PASS) {
    console.error('[index] COOPANEST_USER / COOPANEST_PASS nao configurados');
  }

  startScheduler();
});

process.on('unhandledRejection', (err) => console.error('[index] unhandledRejection:', err));
process.on('uncaughtException', (err) => console.error('[index] uncaughtException:', err));
