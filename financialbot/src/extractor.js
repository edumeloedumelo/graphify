// extractor.js — Claude (Anthropic API) extrai dados estruturados das mensagens
// da secretária: paciente, data, valor e status de pagamento (pago 100%,
// glosa ou pendente). Nenhum regex de parsing: as mensagens são livres demais.

import Anthropic from '@anthropic-ai/sdk';
import { getConfig } from './state.js';

const MODEL = 'claude-sonnet-4-6';

const client = new Anthropic(); // usa ANTHROPIC_API_KEY do ambiente

// Campos obrigatórios para um registro novo
export const REQUIRED_FIELDS = [
  ['paciente', 'nome do paciente'],
  ['data', 'data'],
  ['valor', 'valor'],
];

// Detecção rápida e barata: a mensagem parece um registro financeiro?
// Critério: pelo menos 2 sinais entre nome de paciente, valor em reais,
// data e termo de pagamento. (Só um pré-filtro para não gastar chamadas
// de API; a extração real é do Claude.)
const MONEY_RE = /r\$\s*\d|(\b\d{1,3}(\.\d{3})+(,\d{2})?\b)|(\b\d+(,\d{2})\b)|\b\d{3,}\b/i;
const DATE_RE = /(\b\d{1,2}\/\d{1,2}(\/\d{2,4})?\b)|\bhoje\b|\bontem\b|\bsegunda\b|\bter[çc]a\b|\bquarta\b|\bquinta\b|\bsexta\b|\bs[áa]bado\b|\bdomingo\b/i;
const PAYMENT_RE = /\bpag[oa]\b|\bpagou\b|\bpagamento\b|\bglosa\w*\b|\bpendente\b|\brecebid[oa]\b|\bcaiu\b|\bpix\b|\btransfer[êe]ncia\b|\bdep[óo]sito\b|\bconv[êe]nio\b|\bparticular\b|\b100%\b|\bquitad[oa]\b/i;
// "paciente"/"sr(a)." explícitos, ou nome próprio (duas palavras capitalizadas) em qualquer posição
const PATIENT_RE = /\bpaciente\b|\bpcte\b|\bsr\.?\s|\bsra\.?\s|[A-ZÀ-Ú][a-zà-ú]{2,}\s+(?:d[aeo]s?\s+)?[A-ZÀ-Ú][a-zà-ú]{2,}/;

export function isFinancialRecord(body) {
  if (!body || body.trim().startsWith('/')) return false;
  const text = body.trim();
  let signals = 0;
  if (PATIENT_RE.test(text)) signals++;
  if (MONEY_RE.test(text)) signals++;
  if (DATE_RE.test(text)) signals++;
  if (PAYMENT_RE.test(text)) signals++;
  return signals >= 2;
}

const EXTRACTION_SCHEMA = {
  type: 'object',
  properties: {
    e_registro: {
      type: 'boolean',
      description: 'true se a mensagem descreve um registro financeiro de paciente (novo ou atualização de pagamento)',
    },
    tipo: {
      type: 'string',
      enum: ['novo', 'atualizacao'],
      description: '"novo" = novo atendimento/cobrança; "atualizacao" = pagamento/glosa de um registro já existente (ex: "o pagamento da Maria caiu")',
    },
    paciente: { type: ['string', 'null'], description: 'Nome do paciente' },
    data: { type: ['string', 'null'], description: 'Data do atendimento no formato DD/MM/YYYY' },
    procedimento: { type: ['string', 'null'], description: 'Procedimento/atendimento, se citado' },
    convenio: { type: ['string', 'null'], description: 'Convênio ou "Particular", se citado' },
    valor: { type: ['number', 'null'], description: 'Valor total cobrado, em reais (número)' },
    status_pagamento: {
      type: 'string',
      enum: ['pago', 'glosado', 'pendente'],
      description: '"pago" = pago 100%; "glosado" = houve glosa (pagamento parcial do convênio); "pendente" = ainda não pago',
    },
    valor_pago: { type: ['number', 'null'], description: 'Valor efetivamente recebido, se citado' },
    valor_glosado: { type: ['number', 'null'], description: 'Valor da glosa, se citado' },
    observacoes: { type: ['string', 'null'], description: 'Observações relevantes (motivo da glosa, forma de pagamento etc.)' },
  },
  required: [
    'e_registro', 'tipo', 'paciente', 'data', 'procedimento', 'convenio',
    'valor', 'status_pagamento', 'valor_pago', 'valor_glosado', 'observacoes',
  ],
  additionalProperties: false,
};

function todayInSaoPaulo() {
  const fmt = new Intl.DateTimeFormat('pt-BR', {
    timeZone: 'America/Sao_Paulo',
    day: '2-digit', month: '2-digit', year: 'numeric', weekday: 'long',
  });
  return fmt.format(new Date());
}

function buildSystemPrompt() {
  const extra = getConfig().extraPrompt;
  return [
    'Você extrai dados estruturados de mensagens de WhatsApp enviadas pela secretária de um',
    'consultório de anestesiologia. Ela registra atendimentos de pacientes com valor e situação',
    'de pagamento (pago 100%, glosa do convênio ou pendente). As mensagens são informais e livres.',
    '',
    `Hoje é ${todayInSaoPaulo()} (fuso America/Sao_Paulo).`,
    '',
    'Regras:',
    '- Extraia: paciente, data, valor total, status de pagamento e, se citados, procedimento,',
    '  convênio, valor pago, valor glosado e observações.',
    '- Converta datas relativas ("hoje", "ontem", "segunda", "15/07") para DD/MM/YYYY completo.',
    '  Datas sem ano referem-se ao ano corrente; dias da semana, à ocorrência mais recente.',
    '- Valores em reais como número: "R$3.000" → 3000; "2.850,50" → 2850.5; "3 mil" → 3000.',
    '- status_pagamento: "pago" se pago 100%/quitado; "glosado" se houve glosa (mesmo parcial);',
    '  "pendente" se não pago ou se a mensagem não disser nada sobre pagamento.',
    '- Em glosas: se a mensagem der só o valor da glosa OU só o valor recebido, preencha o que',
    '  foi dito e deixe o outro como null (o sistema calcula a diferença).',
    '- tipo: "atualizacao" quando a mensagem se refere ao pagamento de um registro já feito',
    '  ("caiu o pagamento da Maria", "glosa do João resolvida", "convênio pagou a Ana").',
    '  Nesse caso, data e valor podem ser null.',
    '- Campo ausente na mensagem → null. Não invente dados.',
    '- e_registro: false se for conversa comum, pergunta ou mensagem sem conteúdo financeiro.',
    extra ? `\nInstrução adicional do administrador:\n${extra}` : '',
  ].join('\n');
}

// Extrai os campos de uma mensagem. `previous` (opcional) traz campos já
// extraídos numa tentativa anterior — usado quando o bot perguntou o que
// faltava e a secretária respondeu só com o complemento.
export async function extractRecord(body, previous = null) {
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
  } catch {
    console.error('[extractor] resposta não é JSON válido:', text.slice(0, 200));
    throw new Error('extração falhou');
  }
  console.log('[extractor] extraído:', JSON.stringify(data));
  return data;
}

export function missingFields(data) {
  if (data.tipo === 'atualizacao') {
    return data.paciente ? [] : ['nome do paciente'];
  }
  return REQUIRED_FIELDS.filter(([key]) => {
    const v = data[key];
    return v === null || v === undefined || String(v).trim() === '';
  }).map(([, label]) => label);
}

// Completa valor_pago/valor_glosado a partir do que foi informado.
export function normalizePayment(data) {
  const valor = Number(data.valor) || 0;
  let status = data.status_pagamento || 'pendente';
  let pago = data.valor_pago !== null && data.valor_pago !== undefined ? Number(data.valor_pago) : null;
  let glosa = data.valor_glosado !== null && data.valor_glosado !== undefined ? Number(data.valor_glosado) : null;

  if (status === 'pago') {
    pago = pago ?? valor;
    glosa = glosa ?? 0;
  } else if (status === 'glosado') {
    if (pago === null && glosa !== null && valor) pago = Math.max(valor - glosa, 0);
    if (glosa === null && pago !== null && valor) glosa = Math.max(valor - pago, 0);
  } else {
    pago = pago ?? 0;
    glosa = glosa ?? 0;
  }
  return { ...data, status_pagamento: status, valor_pago: pago, valor_glosado: glosa };
}
