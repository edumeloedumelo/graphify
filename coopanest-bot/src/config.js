import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

export const CONFIG_PATH = process.env.CONFIG_PATH || path.join(ROOT, 'config.json');
export const STATE_DIR = process.env.STATE_DIR || '/data';
const OVERRIDE_PATH = path.join(STATE_DIR, 'config.override.json');

const CACHE_TTL_MS = 30_000;
let cache = null;
let cachedAt = 0;

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') console.error(`[config] falha lendo ${file}:`, err.message);
    return null;
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function deepMerge(base, patch) {
  if (!isPlainObject(patch)) return patch === undefined ? base : patch;
  const out = isPlainObject(base) ? { ...base } : {};
  for (const [key, value] of Object.entries(patch)) {
    out[key] = isPlainObject(value) && isPlainObject(out[key]) ? deepMerge(out[key], value) : value;
  }
  return out;
}

/** Troca "${VAR}" pelo valor da env var correspondente (string vazia se nao existir). */
function resolveEnvRefs(node) {
  if (typeof node === 'string') {
    return node.replace(/\$\{([A-Z0-9_]+)\}/g, (_, name) => process.env[name] ?? '');
  }
  if (Array.isArray(node)) return node.map(resolveEnvRefs);
  if (isPlainObject(node)) {
    const out = {};
    for (const [key, value] of Object.entries(node)) out[key] = resolveEnvRefs(value);
    return out;
  }
  return node;
}

export function getConfig(force = false) {
  const now = Date.now();
  if (!force && cache && now - cachedAt < CACHE_TTL_MS) return cache;

  const base = readJson(CONFIG_PATH) || {};
  const override = readJson(OVERRIDE_PATH) || {};
  const merged = deepMerge(base, override);

  cache = resolveEnvRefs(merged);
  cachedAt = now;
  return cache;
}

/** Grava um patch em /data/config.override.json — permite editar config em runtime. */
export function saveOverride(patch) {
  const current = readJson(OVERRIDE_PATH) || {};
  const next = deepMerge(current, patch);
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(OVERRIDE_PATH, JSON.stringify(next, null, 2));
  cache = null;
  return getConfig(true);
}

export function getDoctors() {
  const cfg = getConfig();
  return (cfg.doctors || []).filter((d) => d && d.id);
}

/** Resolve o medico dono de um chatId de grupo. */
export function doctorByChatId(chatId) {
  if (!chatId) return null;
  return getDoctors().find((d) => d.chatId && d.chatId === chatId) || null;
}

/** Resolve o medico a partir de um nome livre vindo do portal. */
export function doctorByName(name) {
  if (!name) return null;
  const needle = String(name).toLowerCase();
  for (const doctor of getDoctors()) {
    const aliases = [doctor.name, doctor.id, ...(doctor.aliases || [])];
    if (aliases.some((alias) => alias && needle.includes(String(alias).toLowerCase()))) return doctor;
  }
  return null;
}
