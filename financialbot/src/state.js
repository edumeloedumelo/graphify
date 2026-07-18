// state.js — estado persistente no volume Railway (/data)
// Guarda: config.json (valores de procedimentos, prompt extra) e state.json
// (IDs de mensagens já processadas, última sincronização, registros pendentes).

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = path.resolve(__dirname, '..');

function resolveStateDir() {
  const preferred = process.env.STATE_DIR || '/data';
  try {
    fs.mkdirSync(preferred, { recursive: true });
    fs.accessSync(preferred, fs.constants.W_OK);
    return preferred;
  } catch {
    console.warn(`[state] diretório ${preferred} indisponível, usando diretório do projeto`);
    return PROJECT_DIR;
  }
}

export const STATE_DIR = resolveStateDir();
const CONFIG_PATH = path.join(STATE_DIR, 'config.json');
const STATE_PATH = path.join(STATE_DIR, 'state.json');
const SEED_CONFIG_PATH = path.join(PROJECT_DIR, 'config.json');

const DEFAULT_CONFIG = { procedureValues: [], defaultValue: null, extraPrompt: '' };
const DEFAULT_STATE = { processedIds: [], lastSync: null, pending: {} };

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, data) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

let config;
let state;

export function loadAll() {
  if (!fs.existsSync(CONFIG_PATH)) {
    const seed = readJson(SEED_CONFIG_PATH, DEFAULT_CONFIG);
    writeJson(CONFIG_PATH, seed);
    console.log(`[state] config.json inicializado em ${CONFIG_PATH}`);
  }
  config = { ...DEFAULT_CONFIG, ...readJson(CONFIG_PATH, DEFAULT_CONFIG) };
  state = { ...DEFAULT_STATE, ...readJson(STATE_PATH, DEFAULT_STATE) };
  console.log(`[state] carregado de ${STATE_DIR} (${config.procedureValues.length} valores cadastrados)`);
}

export function getConfig() {
  return config;
}

export function saveConfig() {
  writeJson(CONFIG_PATH, config);
}

export function getState() {
  return state;
}

export function saveState() {
  writeJson(STATE_PATH, state);
}

export function isProcessed(messageId) {
  return state.processedIds.includes(messageId);
}

export function markProcessed(messageId) {
  if (!messageId) return;
  state.processedIds.push(messageId);
  if (state.processedIds.length > 500) {
    state.processedIds = state.processedIds.slice(-500);
  }
  saveState();
}

export function setLastSync() {
  state.lastSync = new Date().toISOString();
  saveState();
}

export function resetChat(chatId) {
  state.processedIds = [];
  if (state.pending) delete state.pending[chatId];
  saveState();
}

// ---- registros pendentes (campos obrigatórios faltando) ----

export function setPending(chatId, sender, data) {
  state.pending[`${chatId}|${sender}`] = { data, createdAt: Date.now() };
  saveState();
}

export function getPending(chatId, sender) {
  const entry = state.pending[`${chatId}|${sender}`];
  if (!entry) return null;
  // pendência expira em 15 minutos
  if (Date.now() - entry.createdAt > 15 * 60 * 1000) {
    clearPending(chatId, sender);
    return null;
  }
  return entry.data;
}

export function clearPending(chatId, sender) {
  delete state.pending[`${chatId}|${sender}`];
  saveState();
}
