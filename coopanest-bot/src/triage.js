import { callAnthropic, extractJson, AnthropicError } from './anthropic.js';
import { buildSystemPrompt, buildExtractionPrompt, buildTriagePrompt } from './prompt.js';
import { downloadMediaBlock } from './ultramsg.js';
import { getConfig } from './config.js';
import { toNumber, formatDate, normalize } from './format.js';

/** Baixa as midias do caso, uma por uma — um arquivo ruim nao derruba os outros. */
async function collectMediaBlocks(messages = []) {
  const blocks = [];
  const warnings = [];
  const urlMissing = [];

  for (const message of messages) {
    if (!message) continue;
    if (message.urlMissing) {
      urlMissing.push(message.filename || message.type || 'arquivo');
      continue;
    }
    if (!message.mediaUrl) continue;

    try {
      const { block, filename } = await downloadMediaBlock({
        url: message.mediaUrl,
        filename: message.filename,
        mime: message.mimetype,
      });
      blocks.push({ block, label: filename || message.filename || 'arquivo' });
    } catch (err) {
      warnings.push(`nao consegui ler ${message.filename || 'um arquivo'}: ${err.message}`);
    }
  }

  return { blocks, warnings, urlMissing };
}

/**
 * Chama o Claude removendo progressivamente os blocos de midia rejeitados pela API.
 * Ultimo recurso: manda so o texto.
 */
async function retryWithoutBadBlocks({ system, textPrompt, mediaBlocks }) {
  const remaining = [...mediaBlocks];
  const dropped = [];

  for (;;) {
    const content = [...remaining.map((item) => item.block), { type: 'text', text: textPrompt }];

    try {
      const result = await callAnthropic({ system, messages: [{ role: 'user', content }] });
      return { result, dropped };
    } catch (err) {
      const rejectedPayload = err instanceof AnthropicError && err.status === 400;
      // sem midia sobrando, a ultima tentativa ja foi a de texto puro
      if (!rejectedPayload || remaining.length === 0) throw err;
      dropped.push(remaining.pop().label);
    }
  }
}

const EMPTY_CASE = {
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

/** Normaliza um caso cru vindo do Claude para o shape canonico. */
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

function parseCases(text, defaults) {
  const parsed = extractJson(text);
  if (!parsed) return [];
  const list = Array.isArray(parsed) ? parsed : [parsed];
  return list.map((item) => normalizeCase(item, defaults)).filter(Boolean);
}

/** Analisa um bloco de conversa do grupo e devolve os casos estruturados. */
export async function analyzeConversationCase({ block, doctor }) {
  const system = buildSystemPrompt({ mode: 'triage' });
  const { blocks: mediaBlocks, warnings, urlMissing } = await collectMediaBlocks(block.messages);

  const mediaNote = mediaBlocks.length
    ? `Arquivos anexados: ${mediaBlocks.map((item) => item.label).join(', ')}.`
    : '';

  const textPrompt = buildTriagePrompt({
    caseText: block.text,
    mediaNote,
    doctorName: doctor?.name || '',
  });

  const { result, dropped } = await retryWithoutBadBlocks({ system, textPrompt, mediaBlocks });

  if (dropped.length) warnings.push(`arquivos ignorados pela API: ${dropped.join(', ')}`);

  return {
    cases: parseCases(result.text, doctor?.name ? { medico: doctor.name } : {}),
    warnings,
    urlMissing,
    usage: result.usage,
  };
}

/** Analisa o conteudo bruto de uma pagina do portal e devolve os casos estruturados. */
export async function analyzePortalContent({ label, content }) {
  const cfg = getConfig();
  const chunkSize = cfg.coopanest?.maxHtmlCharsPerChunk || 45_000;
  const system = buildSystemPrompt({ mode: 'extract' });

  const chunks = [];
  for (let i = 0; i < content.length; i += chunkSize) chunks.push(content.slice(i, i + chunkSize));
  if (chunks.length === 0) return { cases: [], warnings: ['pagina vazia'] };

  const cases = [];
  const warnings = [];

  for (const [index, chunk] of chunks.entries()) {
    const pageLabel = chunks.length > 1 ? `${label} (parte ${index + 1}/${chunks.length})` : label;
    try {
      const result = await callAnthropic({
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

/** Remove casos repetidos (mesmo paciente + data + procedimento). */
export function dedupeCases(cases = []) {
  const seen = new Map();
  for (const item of cases) {
    const key = [normalize(item.paciente), normalize(item.data), normalize(item.procedimento)].join('|');
    const existing = seen.get(key);
    if (!existing) {
      seen.set(key, item);
      continue;
    }
    // mantem o registro mais completo
    const score = (obj) => Object.values(obj).filter((value) => value !== '' && value !== null).length;
    if (score(item) > score(existing)) seen.set(key, item);
  }
  return [...seen.values()];
}
