// Estado persistente (Railway volume /data). Fallback para o diretório do
// projeto quando /data não está montado (ex.: desenvolvimento local).
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const PROJECT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function resolveStateDir() {
  const dir = process.env.STATE_DIR || '/data';
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.accessSync(dir, fs.constants.W_OK);
    return dir;
  } catch {
    console.warn(`[state] ${dir} indisponível, usando diretório do projeto`);
    return PROJECT_DIR;
  }
}

export const STATE_DIR = resolveStateDir();

const CONFIG_PATH = path.join(STATE_DIR, 'config.json');
const STATE_PATH = path.join(STATE_DIR, 'state.json');
const SEED_CONFIG_PATH = path.join(PROJECT_DIR, 'config.json');

const DEFAULT_CONFIG = { procedureValues: [], defaultValue: null, extraPrompt: '' };
const DEFAULT_STATE = { lastSync: null, pending: {} };

function readJson(file, fallback) {
  try {
    return { ...fallback, ...JSON.parse(fs.readFileSync(file, 'utf8')) };
  } catch {
    return null;
  }
}

function writeJson(file, data) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

export function loadConfig() {
  // 1º config.json no volume; senão semeia a partir do config.json do projeto
  let cfg = readJson(CONFIG_PATH, DEFAULT_CONFIG);
  if (!cfg) {
    cfg = readJson(SEED_CONFIG_PATH, DEFAULT_CONFIG) || { ...DEFAULT_CONFIG };
    saveConfig(cfg);
    console.log('[state] config.json inicial criado em', CONFIG_PATH);
  }
  return cfg;
}

export function saveConfig(cfg) {
  writeJson(CONFIG_PATH, cfg);
}

export function loadState() {
  return readJson(STATE_PATH, DEFAULT_STATE) || { ...DEFAULT_STATE };
}

export function saveState(state) {
  writeJson(STATE_PATH, state);
}

// ---- registros pendentes (campos obrigatórios faltando) ----
// chave: `${chatId}:${author}` para não misturar registros de pessoas diferentes
export function getPending(chatId, author) {
  const state = loadState();
  return state.pending?.[`${chatId}:${author}`] || null;
}

export function setPending(chatId, author, record) {
  const state = loadState();
  state.pending = state.pending || {};
  if (record) state.pending[`${chatId}:${author}`] = { record, at: Date.now() };
  else delete state.pending[`${chatId}:${author}`];
  saveState(state);
}

export function touchLastSync() {
  const state = loadState();
  state.lastSync = new Date().toISOString();
  saveState(state);
}
