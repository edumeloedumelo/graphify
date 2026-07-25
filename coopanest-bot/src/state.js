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
    cache = { values: {} };
  }
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
