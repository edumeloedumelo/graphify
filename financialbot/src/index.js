// Financial Bot Control — webhook UltraMsg -> Claude -> Google Sheets.
import 'dotenv/config';
import express from 'express';
import { handleWebhook } from './router.js';
import { STATE_DIR, loadConfig } from './state.js';

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));

app.get('/', (_req, res) => {
  res.json({ ok: true, service: 'financialbot' });
});

app.post('/webhook', (req, res) => {
  // responde imediatamente; processamento segue assíncrono
  res.sendStatus(200);
  handleWebhook(req.body).catch((err) => {
    console.error('[index] erro não tratado no webhook:', err);
  });
});

const required = ['ULTRAMSG_INSTANCE_ID', 'ULTRAMSG_TOKEN', 'ANTHROPIC_API_KEY', 'GOOGLE_SERVICE_ACCOUNT', 'SPREADSHEET_ID'];
for (const name of required) {
  if (!process.env[name]) console.warn(`[index] atenção: variável ${name} não configurada`);
}

const cfg = loadConfig();
console.log(`[index] estado em ${STATE_DIR} — ${cfg.procedureValues.length} procedimentos com valor cadastrado`);

const port = Number(process.env.PORT) || 3000;
app.listen(port, () => {
  console.log(`[index] Financial Bot Control ouvindo na porta ${port} (webhook: POST /webhook)`);
});
