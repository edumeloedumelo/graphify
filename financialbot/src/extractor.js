// extractor.js — Claude (Anthropic API) extrai dados estruturados de mensagens
// livres do grupo. Nenhum regex de parsing: as mensagens são livres demais.

import Anthropic from '@anthropic-ai/sdk';
import { getConfig } from './state.js';

const MODEL = 'claude-sonnet-4-6';

const client = new Anthropic(); // usa ANTHROPIC_API_KEY do ambiente

export const REQUIRED_FIELDS = [
  ['nome_anestesista', 'anestesista'],
  ['hospital', 'hospital'],
  ['procedimento', 'procedimento'],
  ['cirurgiao', 'cirurgião'],
  ['data', 'data'],
];

// Detecção rápida e barata: a mensagem parece um registro de procedimento?
// Critério: pelo menos 2 sinais entre médico, hospital/clínica, procedimento e data.
// (É só um pré-filtro para não gastar chamadas de API; a extração real é do Claude.)
const PROCEDURE_HINTS = [
  'ectomia', 'plastia', 'tomia', 'scopia', 'rafia', 'pexia', 'cirurgia',
  'anestesia', 'bloqueio', 'sedação', 'sedacao', 'parto', 'cesárea', 'cesarea',
  'hernia', 'hérnia', 'lipo', 'protese', 'prótese', 'artro', 'endoscopia',
  'colono', 'cateter', 'biópsia', 'biopsia', 'implante', 'exérese', 'exerese',
];
const HOSPITAL_HINTS = ['hospital', 'clínica', 'clinica', 'hosp.', 'hosp ', 'maternidade', 'casa de saúde', 'casa de saude', "d'or", 'unimed', 'hse', 'upa', 'santa casa'];
const DATE_RE = /(\b\d{1,2}\/\d{1,2}(\/\d{2,4})?\b)|\bhoje\b|\bontem\b|\bamanh[ãa]\b|\bsegunda\b|\bter[çc]a\b|\bquarta\b|\bquinta\b|\bsexta\b|\bs[áa]bado\b|\bdomingo\b/i;
const DOCTOR_RE = /\b(dr|dra|doutor|doutora|anestesista|cirurgi[ãa]o|cirurgi[ãa])\b\.?/i;

export function isMedicalRecord(body) {
  if (!body || body.trim().startsWith('/')) return false;
  const text = body.toLowerCase();
  let signals = 0;
  if (DOCTOR_RE.test(text)) signals++;
  if (HOSPITAL_HINTS.some((h) => text.includes(h))) signals++;
  if (PROCEDURE_HINTS.some((p) => text.includes(p))) signals++;
  if (DATE_RE.test(text)) signals++;
  return signals >= 2;
}

const EXTRACTION_SCHEMA = {
  type: 'object',
  properties: {
    e_registro: {
      type: 'boolean',
      description: 'true se a mensagem realmente descreve um procedimento cirúrgico/anestésico a registrar',
    },
    nome_anestesista: { type: ['string', 'null'] },
    hospital: { type: ['string', 'null'] },
    procedimento: { type: ['string', 'null'] },
    cirurgiao: { type: ['string', 'null'] },
    data: { type: ['string', 'null'], description: 'Data no formato DD/MM/YYYY' },
    status: { type: 'string', enum: ['realizado', 'pendente', 'cancelado'] },
  },
  required: ['e_registro', 'nome_anestesista', 'hospital', 'procedimento', 'cirurgiao', 'data', 'status'],
  additionalProperties: false,
};

function todayInSaoPaulo() {
  const now = new Date();
  const fmt = new Intl.DateTimeFormat('pt-BR', {
    timeZone: 'America/Sao_Paulo',
    day: '2-digit', month: '2-digit', year: 'numeric', weekday: 'long',
  });
  return fmt.format(now);
}

function buildSystemPrompt() {
  const extra = getConfig().extraPrompt;
  return [
    'Você extrai dados estruturados de mensagens de WhatsApp de um grupo de anestesiologistas',
    'que registram procedimentos cirúrgicos realizados. As mensagens são informais e em formato livre.',
    '',
    `Hoje é ${todayInSaoPaulo()} (fuso America/Sao_Paulo).`,
    '',
    'Regras:',
    '- Extraia: nome do anestesista, hospital/clínica, procedimento, cirurgião e data.',
    '- Converta datas relativas ("hoje", "ontem", "segunda", "15/07") para DD/MM/YYYY completo.',
    '  Datas sem ano referem-se ao ano corrente; dias da semana referem-se à ocorrência mais recente (passada ou hoje).',
    '- Preserve títulos (Dr., Dra.) nos nomes. Se a mensagem indicar quem é o anestesista e quem é o cirurgião, respeite os papéis.',
    '- Se um papel não estiver explícito: o primeiro nome citado costuma ser o anestesista e o nome após "Cirurgião:" ou similar é o cirurgião.',
    '- NUNCA extraia valores monetários; eles não fazem parte da extração.',
    '- Campo ausente na mensagem → null. Não invente dados.',
    '- status: "realizado" por padrão, a menos que a mensagem diga que está pendente/agendado ou foi cancelado.',
    '- e_registro: false se a mensagem for conversa comum, pergunta ou não descrever um procedimento.',
    extra ? `\nInstrução adicional do administrador:\n${extra}` : '',
  ].join('\n');
}

// Extrai os campos de uma mensagem. `previous` (opcional) traz campos já
// extraídos numa tentativa anterior — usado quando o bot perguntou o que faltava
// e o usuário respondeu só com o complemento.
export async function extractProcedure(body, previous = null) {
  const userContent = previous
    ? `Registro parcial já extraído:\n${JSON.stringify(previous)}\n\nNova mensagem do mesmo usuário complementando o registro:\n"""${body}"""\n\nCombine as informações e retorne o registro completo (e_registro: true).`
    : `Mensagem do grupo:\n"""${body}"""`;

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 1024,
    system: buildSystemPrompt(),
    output_config: { format: { type: 'json_schema', schema: EXTRACTION_SCHEMA } },
    messages: [{ role: 'user', content: userContent }],
  });

  const text = response.content.find((b) => b.type === 'text')?.text ?? '{}';
  let data;
  try {
    data = JSON.parse(text);
  } catch (err) {
    console.error('[extractor] resposta não é JSON válido:', text.slice(0, 200));
    throw new Error('extração falhou');
  }
  console.log('[extractor] extraído:', JSON.stringify({ ...data }));
  return data;
}

export function missingFields(data) {
  return REQUIRED_FIELDS.filter(([key]) => {
    const v = data[key];
    return v === null || v === undefined || String(v).trim() === '';
  }).map(([, label]) => label);
}

// ---- lookup interno de valor (NUNCA exposto no WhatsApp) ----

function normalize(s) {
  return String(s)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .trim();
}

export function lookupValue(procedimento) {
  const { procedureValues, defaultValue } = getConfig();
  if (!procedimento) return defaultValue ?? null;
  const target = normalize(procedimento);

  // 1. correspondência exata (case/acento-insensitive)
  const exact = procedureValues.find((p) => normalize(p.procedure) === target);
  if (exact) return exact.value;

  // 2. correspondência parcial em qualquer direção
  //    ("mamoplastia" encontra "Mamoplastia de Aumento" e vice-versa)
  const partial = procedureValues.find((p) => {
    const cand = normalize(p.procedure);
    return cand.includes(target) || target.includes(cand);
  });
  if (partial) return partial.value;

  return defaultValue ?? null;
}
