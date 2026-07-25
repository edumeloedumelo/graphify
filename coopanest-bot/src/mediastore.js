import fs from 'node:fs';
import path from 'node:path';

export const STATE_DIR = process.env.STATE_DIR || '/data';
const MEDIA_FILE = path.join(STATE_DIR, 'media.json');

const MAX_PER_CHAT = 400;
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

let cache = null;

function load() {
  if (cache) return cache;
  try {
    cache = JSON.parse(fs.readFileSync(MEDIA_FILE, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') console.error('[mediastore] arquivo ilegivel, recomecando:', err.message);
    cache = {};
  }
  return cache;
}

function persist() {
  const data = load();
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    const tmp = `${MEDIA_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data));
    fs.renameSync(tmp, MEDIA_FILE);
  } catch (err) {
    console.error('[mediastore] falha ao gravar:', err.message);
  }
}

function prune(entries) {
  const cutoff = Date.now() - MAX_AGE_MS;
  const fresh = entries.filter((entry) => (entry.savedAt || 0) >= cutoff);
  return fresh.slice(-MAX_PER_CHAT);
}

/**
 * Guarda a URL de uma midia recebida via webhook, indexada por chat.
 * O UltraMsg so entrega a URL no webhook — a busca por /chats/messages nem sempre traz.
 */
export function saveMedia(chatId, { messageId, url, mime, filename, caption, timestamp }) {
  if (!chatId || !url) return;
  const store = load();
  const entries = store[chatId] || [];
  const existing = entries.find((entry) => entry.messageId && entry.messageId === messageId);
  if (existing) {
    existing.url = url;
    existing.mime = mime || existing.mime;
    existing.filename = filename || existing.filename;
    existing.caption = caption || existing.caption;
  } else {
    entries.push({
      messageId: messageId || `${chatId}:${timestamp || Date.now()}`,
      url,
      mime: mime || '',
      filename: filename || '',
      caption: caption || '',
      timestamp: Number(timestamp) || Math.floor(Date.now() / 1000),
      savedAt: Date.now(),
    });
  }
  store[chatId] = prune(entries);
  persist();
}

export function getMedia(chatId, { since = 0, until = Infinity } = {}) {
  const entries = load()[chatId] || [];
  return entries
    .filter((entry) => entry.timestamp >= since && entry.timestamp <= until)
    .sort((a, b) => a.timestamp - b.timestamp);
}

/** Procura a URL de uma midia especifica — por id da mensagem ou por proximidade de timestamp. */
export function findMediaUrl(chatId, { messageId, timestamp } = {}) {
  const entries = load()[chatId] || [];
  if (messageId) {
    const byId = entries.find((entry) => entry.messageId === messageId);
    if (byId) return byId;
  }
  if (timestamp) {
    const ts = Number(timestamp);
    const near = entries.filter((entry) => Math.abs(entry.timestamp - ts) <= 5);
    if (near.length) return near[0];
  }
  return null;
}

export function clearChat(chatId) {
  const store = load();
  delete store[chatId];
  persist();
}
