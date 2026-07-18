// Extração de dados estruturados de registros de procedimentos via Claude.
// A detecção (isMedicalRecord) é heurística e barata; o parsing dos campos é
// sempre feito pelo Claude — mensagens são livres demais para regex.
import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic();
const MODEL = 'claude-sonnet-4-6';
const TZ = 'America/Sao_Paulo';

const REQUIRED_FIELDS = ['nome_anestesista', 'hospital', 'procedimento', 'cirurgiao', 'data'];

const FIELD_LABELS = {
  nome_anestesista: 'anestesista',
  hospital: 'hospital/clínica',
  procedimento: 'procedimento',
  cirurgiao: 'cirurgião',
  data: 'data',
};

// ---------- detecção automática ----------

const RX_DOCTOR = /\b(dr\.?|dra\.?|doutor(a)?|anestesista\s*:?)\b/i;
const RX_HOSPITAL = /\b(hospital|cl[ií]nica|hosp\.|hse|copa\s*d.?or|samaritano|santa\s+\w+|s[ãa]o\s+\w+)\b/i;
const RX_PROCEDURE =
  /(ectomia|plastia|r[ao]fia|pexia|scopia|videolaparoscop|artroscop|cesariana|cesárea|parto|hérnia|hernia|cateter|endoscopia|colonoscopia|cirurgia|anestesia|bloqueio|l[íi]po|implante|pr[óo]tese)/i;
const RX_DATE =
  /(\b\d{1,2}\/\d{1,2}(\/\d{2,4})?\b|\bhoje\b|\bontem\b|\banteontem\b|\bsegunda\b|\bter[çc]a\b|\bquarta\b|\bquinta\b|\bsexta\b|\bs[áa]bado\b|\bdomingo\b|\bamanh[ãa]\b)/i;

export function isMedicalRecord(body) {
  if (!body || body.length < 10) return false;
  let signals = 0;
  if (RX_DOCTOR.test(body)) signals++;
  if (RX_HOSPITAL.test(body)) signals++;
  if (RX_PROCEDURE.test(body)) signals++;
  if (RX_DATE.test(body)) signals++;
  return signals >= 2;
}

// ---------- extração via Claude ----------

const SCHEMA = {
  type: 'object',
  properties: {
    nome_anestesista: { type: ['string', 'null'] },
    hospital: { type: ['string', 'null'] },
    procedimento: { type: ['string', 'null'] },
    cirurgiao: { type: ['string', 'null'] },
    data: { type: ['string', 'null'], description: 'DD/MM/YYYY' },
    status: { type: 'string' },
  },
  required: ['nome_anestesista', 'hospital', 'procedimento', 'cirurgiao', 'data', 'status'],
  additionalProperties: false,
};

function todayInfo() {
  const now = new Date();
  const fmt = new Intl.DateTimeFormat('pt-BR', {
    timeZone: TZ, day: '2-digit', month: '2-digit', year: 'numeric', weekday: 'long',
  });
  const parts = Object.fromEntries(fmt.formatToParts(now).map((p) => [p.type, p.value]));
  return {
    date: `${parts.day}/${parts.month}/${parts.year}`,
    weekday: parts.weekday,
  };
}

function buildSystem(extraPrompt, existing) {
  const { date, weekday } = todayInfo();
  let system = `Você extrai dados estruturados de mensagens de WhatsApp sobre procedimentos de anestesiologia no Brasil.

Hoje é ${weekday}, ${date} (fuso ${TZ}).

Regras:
- Extraia: nome_anestesista, hospital, procedimento, cirurgiao, data, status.
- O anestesista é quem realizou a anestesia. Rótulos como "Anestesista:" identificam-no. Quando a mensagem lista dois médicos sem rótulos (ex.: "Dr. A - Hospital - Procedimento - Dr. B - data"), o primeiro é o anestesista e o segundo é o cirurgião. Rótulos como "Cirurgião:" identificam o cirurgião.
- Preserve títulos (Dr., Dra.) quando presentes.
- data: converta SEMPRE para DD/MM/YYYY. "hoje" = ${date}. "ontem" = dia anterior. Dias da semana referem-se à ocorrência mais recente (passada ou hoje). Datas sem ano usam o ano corrente.
- status: "realizado" por padrão; use "pendente" ou "cancelado" apenas se a mensagem indicar.
- Campo ausente na mensagem = null. NÃO invente valores.
- NUNCA extraia valores monetários; ignore qualquer menção a dinheiro.`;

  if (existing) {
    system += `\n\nJá existe um registro parcial: ${JSON.stringify(existing)}.
A mensagem do usuário complementa esse registro. Retorne o registro COMPLETO mesclado (mantenha os campos já preenchidos, preencha os que a nova mensagem fornecer).`;
  }
  if (extraPrompt) {
    system += `\n\nInstrução adicional do administrador:\n${extraPrompt}`;
  }
  return system;
}

export async function extractRecord(body, { extraPrompt = '', existing = null } = {}) {
  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 1024,
    system: buildSystem(extraPrompt, existing),
    output_config: { format: { type: 'json_schema', schema: SCHEMA } },
    messages: [{ role: 'user', content: body }],
  });

  if (response.stop_reason === 'refusal') {
    console.warn('[extractor] extração recusada pelo modelo');
    return null;
  }

  const text = response.content.find((b) => b.type === 'text')?.text;
  if (!text) return null;

  let record;
  try {
    record = JSON.parse(text);
  } catch (err) {
    console.error('[extractor] JSON inválido na resposta:', err.message);
    return null;
  }

  record.status = record.status || 'realizado';
  record.data = normalizeDate(record.data);
  return record;
}

// Garante DD/MM/YYYY mesmo se o modelo devolver D/M ou sem ano.
function normalizeDate(value) {
  if (!value) return null;
  const m = String(value).match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?$/);
  if (!m) return value;
  const { date } = todayInfo();
  const currentYear = date.slice(-4);
  let year = m[3] || currentYear;
  if (year.length === 2) year = `20${year}`;
  return `${m[1].padStart(2, '0')}/${m[2].padStart(2, '0')}/${year}`;
}

export function missingFields(record) {
  return REQUIRED_FIELDS.filter((f) => !record?.[f]);
}

export function missingFieldsLabels(record) {
  return missingFields(record).map((f) => FIELD_LABELS[f]);
}
