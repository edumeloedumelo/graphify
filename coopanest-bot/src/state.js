import fs from 'node:fs';
import path from 'node:path';

export const STATE_DIR = process.env.STATE_DIR || '/data';
const STATE_FILE = path.join(STATE_DIR, 'state.json');

let cache = null;

function load() {
  if (cache) return cache;
  try {
    cache = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') console.error('[state] arquivo ilegivel, recomecando:', err.message);
    cache = { lastTime: {}, values: {} };
  }
  cache.lastTime = cache.lastTime || {};
  cache.values = cache.values || {};
  return cache;
}

function persist() {
  const data = load();
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    const tmp = `${STATE_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, STATE_FILE);
  } catch (err) {
    console.error('[state] falha ao gravar:', err.message);
  }
}

/** Timestamp (segundos) da ultima mensagem ja processada naquele chat. */
export function getLastTime(chatId) {
  return load().lastTime[chatId] || 0;
}

export function setLastTime(chatId, timestamp) {
  const ts = Number(timestamp) || 0;
  if (!chatId || !ts) return;
  load().lastTime[chatId] = ts;
  persist();
}

/** Avanca o marcador apenas se o novo timestamp for maior. */
export function bumpLastTime(chatId, timestamp) {
  const ts = Number(timestamp) || 0;
  if (!chatId || !ts) return;
  const state = load();
  if (ts > (state.lastTime[chatId] || 0)) {
    state.lastTime[chatId] = ts;
    persist();
  }
}

export function getValue(key, fallback = null) {
  const value = load().values[key];
  return value === undefined ? fallback : value;
}

export function setValue(key, value) {
  load().values[key] = value;
  persist();
}

export function dump() {
  return JSON.parse(JSON.stringify(load()));
}
