import { callAnthropic, extractJson, AnthropicError } from './anthropic.js';
import { buildSystemPrompt, buildExtractionPrompt } from './prompt.js';
import { getConfig } from './config.js';
import { toNumber, formatDate, normalize } from './format.js';

const EMPTY_CASE = {
  guia: '',
  url: '',
  statusOriginal: '',
  paciente: '',
  medico: '',
  procedimento: '',
  data: '',
  hospital: '',
  convenio: '',
  status: '',
  valorBruto: '',
  valorPago: '',
  valorReceber: '',
  glosa: '',
  recursoGlosa: '',
  parceiro: '',
  observacoes: '',
};

const MONEY_FIELDS = ['valorBruto', 'valorPago', 'valorReceber', 'glosa'];

/** Normaliza um caso cru vindo do Claude para o shape canônico. */
export function normalizeCase(raw, defaults = {}) {
  if (!raw || typeof raw !== 'object') return null;
  const out = { ...EMPTY_CASE, ...defaults };

  for (const key of Object.keys(EMPTY_CASE)) {
    const value = raw[key];
    if (value === null || value === undefined) continue;
    out[key] = String(value).trim();
  }

  out.data = formatDate(out.data);
  for (const field of MONEY_FIELDS) {
    const num = toNumber(out[field]);
    out[field] = num === null ? '' : num;
  }

  if (!out.paciente && !out.procedimento) return null;
  return out;
}

function parseCases(text) {
  const parsed = extractJson(text);
  if (!parsed) return [];
  const list = Array.isArray(parsed) ? parsed : [parsed];
  return list.map((item) => normalizeCase(item)).filter(Boolean);
}

/** Uma nova tentativa em erro transitório (429/5xx/timeout), com espera curta. */
async function callWithRetry(args, { retries = 1 } = {}) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await callAnthropic(args);
    } catch (err) {
      lastError = err;
      const retryable = err instanceof AnthropicError && err.retryable;
      if (!retryable || attempt === retries) throw err;
      await new Promise((resolve) => setTimeout(resolve, 3000 * (attempt + 1)));
    }
  }
  throw lastError;
}

/**
 * Manda o conteúdo de uma página do portal para o Claude e devolve as cirurgias.
 * Páginas grandes são quebradas em pedaços; um pedaço que falha não derruba os outros.
 */
export async function extractCases({ label, content }) {
  const cfg = getConfig();
  const chunkSize = cfg.coopanest?.maxHtmlCharsPerChunk || 45_000;
  const system = buildSystemPrompt();

  const chunks = [];
  for (let i = 0; i < content.length; i += chunkSize) chunks.push(content.slice(i, i + chunkSize));
  if (chunks.length === 0) return { cases: [], warnings: [] };

  const cases = [];
  const warnings = [];

  for (const [index, chunk] of chunks.entries()) {
    const pageLabel = chunks.length > 1 ? `${label} (parte ${index + 1}/${chunks.length})` : label;
    try {
      const result = await callWithRetry({
        system,
        messages: [{ role: 'user', content: buildExtractionPrompt({ pageLabel, content: chunk }) }],
      });
      cases.push(...parseCases(result.text));
    } catch (err) {
      warnings.push(`falha lendo ${pageLabel}: ${err.message}`);
    }
  }

  return { cases: dedupeCases(cases), warnings };
}

function stripEmpty(item) {
  const out = {};
  for (const [key, value] of Object.entries(item)) {
    if (value !== '' && value !== null && value !== undefined) out[key] = value;
  }
  return out;
}

/**
 * Remove casos repetidos (mesmo paciente + data + procedimento).
 * A mesma cirurgia costuma aparecer na listagem e na tela de detalhe — o
 * resultado junta as duas, ficando com o valor preenchido de cada campo.
 */
export function dedupeCases(cases = []) {
  const seen = new Map();
  const score = (item) => Object.values(item).filter((value) => value !== '' && value !== null).length;

  for (const item of cases) {
    // mesma prioridade da chave de identidade: o numero do portal manda
    const identificador = String(item.guia || '').replace(/\D/g, '');
    const key =
      identificador.length >= 4
        ? `g${identificador}`
        : [normalize(item.paciente), normalize(item.data), normalize(item.procedimento)].join('|');
    const existing = seen.get(key);
    if (!existing) {
      seen.set(key, item);
      continue;
    }
    const richer = score(item) >= score(existing) ? item : existing;
    const poorer = richer === item ? existing : item;
    seen.set(key, { ...poorer, ...stripEmpty(richer) });
  }

  return [...seen.values()];
}
