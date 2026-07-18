// index.js — servidor Express que recebe o webhook do UltraMsg.
// Configure no UltraMsg: URL = https://SEU-DOMINIO/webhook

import 'dotenv/config';
import express from 'express';
import { loadAll } from './state.js';
import { handleIncoming } from './router.js';

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));

loadAll();

app.get('/', (_req, res) => {
  res.json({ ok: true, service: 'financialbot', time: new Date().toISOString() });
});

// Normaliza o payload do UltraMsg para o formato interno do router.
function normalizeWebhook(payload) {
  const d = payload?.data || payload;
  if (!d) return null;
  const chatId = d.from || d.chatId; // grupo: "...@g.us" | privado: "...@c.us"
  if (!chatId) return null;
  return {
    id: d.id || null,
    chatId,
    // em grupos, "author" é quem enviou; em chat privado é o próprio "from"
    sender: d.author || d.participant || d.from || '',
    body: typeof d.body === 'string' ? d.body : '',
    fromMe: Boolean(d.fromMe || d.self),
    type: d.type || 'chat',
  };
}

app.post('/webhook', (req, res) => {
  // responde imediatamente; processamento segue em background
  res.status(200).json({ ok: true });

  const payload = req.body;
  const eventType = payload?.event_type || payload?.eventType || '';
  if (eventType && !['message_received', 'message_create'].includes(eventType)) {
    return; // acks, status etc.
  }

  const msg = normalizeWebhook(payload);
  if (!msg) return;
  if (msg.type && !['chat', 'text'].includes(msg.type)) return; // só texto

  console.log(`[webhook] msg de ${msg.sender} em ${msg.chatId}: "${msg.body.slice(0, 80)}"`);
  handleIncoming(msg).catch((err) => {
    console.error('[webhook] erro não tratado:', err);
  });
});

const PORT = Number(process.env.PORT || 3000);
app.listen(PORT, () => {
  console.log(`[index] Financial Bot Control ouvindo na porta ${PORT}`);
  const required = [
    'ULTRAMSG_INSTANCE_ID', 'ULTRAMSG_TOKEN', 'ANTHROPIC_API_KEY',
    'GOOGLE_SERVICE_ACCOUNT', 'SPREADSHEET_ID',
  ];
  const missing = required.filter((v) => !process.env[v]);
  if (missing.length) {
    console.warn(`[index] variáveis de ambiente ausentes: ${missing.join(', ')}`);
  }
});
