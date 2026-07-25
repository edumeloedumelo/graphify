import { saveMedia } from './mediastore.js';
import { handleCommand, parseCommand } from './commands.js';

const IGNORED_EVENTS = new Set(['message_ack', 'message_create', 'message_status']);

function allowedChats() {
  return (process.env.ALLOWED_CHATS || '')
    .split(',')
    .map((chat) => chat.trim())
    .filter(Boolean);
}

export function isChatAllowed(chatId) {
  const list = allowedChats();
  if (list.length === 0) return true;
  return list.some((allowed) => chatId === allowed || chatId.startsWith(allowed));
}

function toSeconds(value) {
  if (!value) return Math.floor(Date.now() / 1000);
  const num = Number(value);
  if (Number.isFinite(num) && num > 0) return num > 1e12 ? Math.floor(num / 1000) : Math.floor(num);
  const parsed = Date.parse(String(value).replace(' ', 'T'));
  return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : Math.floor(Date.now() / 1000);
}

/** Normaliza o payload do UltraMsg para o shape usado no resto do bot. */
export function normalizeWebhook(payload = {}) {
  const data = payload.data && typeof payload.data === 'object' ? payload.data : payload;
  const type = data.type || 'chat';
  const fromMe = data.fromMe === true || data.fromMe === 'true';

  // em mensagem de midia o UltraMsg poe a URL no body e o texto na caption
  const isMedia = type !== 'chat' && type !== 'text';
  const mediaUrl = data.media || (isMedia && /^https?:\/\//i.test(data.body || '') ? data.body : '');
  const body = isMedia ? String(data.caption || '').trim() : String(data.body || '').trim();

  return {
    eventType: payload.event_type || 'message_received',
    chatId: fromMe && data.to ? data.to : data.from || '',
    messageId: data.id || '',
    author: data.author || data.from || '',
    pushname: data.pushname || '',
    type,
    body,
    fromMe,
    mediaUrl,
    filename: data.filename || data.fileName || '',
    mimetype: data.mimetype || data.mime || '',
    timestamp: toSeconds(data.time || data.timestamp),
  };
}

/**
 * Ponto de entrada do webhook: guarda mídias e roteia comandos.
 * Não responde a mensagens comuns — a planilha é atualizada pela varredura
 * automática ou pelo /analisar.
 */
export async function routeWebhook(payload) {
  if (payload?.event_type && IGNORED_EVENTS.has(payload.event_type)) {
    return { ignored: true, reason: `evento ${payload.event_type}` };
  }

  const message = normalizeWebhook(payload);

  if (!message.chatId) return { ignored: true, reason: 'sem chatId' };
  if (!isChatAllowed(message.chatId)) return { ignored: true, reason: 'chat fora do ALLOWED_CHATS' };

  if (message.mediaUrl) {
    saveMedia(message.chatId, {
      messageId: message.messageId,
      url: message.mediaUrl,
      mime: message.mimetype,
      filename: message.filename,
      caption: message.body,
      timestamp: message.timestamp,
    });
  }

  const command = parseCommand(message.body);
  if (!command) return { ignored: true, reason: 'mensagem sem comando', cachedMedia: Boolean(message.mediaUrl) };

  console.log(`[router] /${command.name} de ${message.author} em ${message.chatId}`);

  await handleCommand({
    chatId: message.chatId,
    text: message.body,
    author: message.author,
    timestamp: message.timestamp,
  });

  return { handled: true, command: command.name };
}
