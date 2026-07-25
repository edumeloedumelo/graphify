import { apiBase } from './ultramsg.js';
import { findMediaUrl } from './mediastore.js';

export const LOOKBACK_SECONDS = Number(process.env.LOOKBACK_SECONDS) || 3600;

const PAGE_LIMIT = 200;
const REQUEST_TIMEOUT_MS = 30_000;

function toSeconds(value) {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return 0;
  return num > 1e12 ? Math.floor(num / 1000) : Math.floor(num);
}

function normalizeMessage(raw, chatId) {
  const timestamp = toSeconds(raw.time ?? raw.timestamp ?? raw.t);
  const id = raw.id || raw.messageId || `${chatId}:${timestamp}`;
  const type = raw.type || 'chat';
  const mediaUrl = raw.media || raw.url || '';
  const cached = mediaUrl ? null : findMediaUrl(chatId, { messageId: id, timestamp });

  return {
    id,
    chatId,
    timestamp,
    type,
    body: String(raw.body ?? raw.caption ?? '').trim(),
    caption: String(raw.caption ?? '').trim(),
    fromMe: raw.fromMe === true || raw.fromMe === 'true',
    author: raw.author || raw.from || '',
    filename: raw.filename || raw.fileName || '',
    mimetype: raw.mimetype || raw.mime || '',
    mediaUrl: mediaUrl || cached?.url || '',
    urlMissing: type !== 'chat' && !mediaUrl && !cached?.url,
  };
}

async function fetchPage({ chatId, page, limit }) {
  const instanceToken = process.env.ULTRAMSG_TOKEN;
  if (!instanceToken) throw new Error('ULTRAMSG_TOKEN nao configurado');

  const url = new URL(`${apiBase()}/chats/messages`);
  url.searchParams.set('token', instanceToken);
  url.searchParams.set('chatId', chatId);
  url.searchParams.set('limit', String(limit));
  url.searchParams.set('page', String(page));

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(url, { signal: controller.signal });
    const raw = await response.text();
    if (!response.ok) throw new Error(`UltraMsg /chats/messages ${response.status}: ${raw.slice(0, 300)}`);

    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      throw new Error('resposta de /chats/messages nao e JSON');
    }
    if (Array.isArray(data)) return data;
    if (Array.isArray(data.messages)) return data.messages;
    return [];
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Busca mensagens novas de um chat: posteriores a `since` (ou ao lookback padrao),
 * sem as do proprio bot, ordenadas por timestamp crescente.
 */
export async function fetchNewMessages(chatId, since = 0, { limit = PAGE_LIMIT } = {}) {
  if (!chatId) throw new Error('fetchNewMessages: chatId ausente');

  const floor = since > 0 ? since : Math.floor(Date.now() / 1000) - LOOKBACK_SECONDS;
  const raw = await fetchPage({ chatId, page: 1, limit });

  return raw
    .map((item) => normalizeMessage(item, chatId))
    .filter((message) => message.timestamp > floor)
    .sort((a, b) => a.timestamp - b.timestamp);
}

export function newestTimestamp(messages = []) {
  return messages.reduce((max, message) => Math.max(max, message.timestamp || 0), 0);
}
