/**
 * Agrupa as mensagens de um grupo em "casos" (cirurgias).
 * Um caso comeca num abridor (ex.: "Paciente: ...", "NOVO CASO", "1)") e termina
 * num separador (linha de tracos) ou no proximo abridor.
 */

const SEPARATOR_RE = /^\s*(?:[-=_~*+•.]\s*){3,}$/;

const CASE_OPENER_RE = new RegExp(
  [
    '^\\s*\\*?\\s*(?:novo\\s+)?caso\\b',
    '^\\s*\\*?\\s*(?:paciente|pac\\.?|pct)\\s*[:\\-]',
    '^\\s*\\*?\\s*(?:cirurgia|procedimento|proc\\.?)\\s*[:\\-]',
    '^\\s*\\d{1,3}\\s*[).\\-]\\s+\\S',
  ].join('|'),
  'i',
);

/** Marcadores fixos que o bot usa no inicio das suas proprias mensagens. */
const BOT_PREFIXES = [
  '🤖',
  '⏳',
  '✅',
  '❌',
  '⚠️',
  '📋',
  '📊',
  '💰',
  '🔄',
  '🔒',
  'ℹ️',
];

const BOT_PHRASES = [
  'coopanest bot',
  'analisando',
  'nenhuma mensagem nova',
  'ja tem uma analise rodando',
  'já tem uma análise rodando',
  'erro ao analisar',
  'erro na sincronizacao',
  'erro na sincronização',
  'comandos disponiveis',
  'comandos disponíveis',
  'sincronizacao concluida',
  'sincronização concluída',
  'planilha atualizada',
  'resumo do caso',
  'salario da sara',
  'salário da sara',
];

/** Strings curtas e estaveis — nao dependem de como o Claude formatou o laudo. */
const SUCCESS_MARKERS = ['resumo do caso', 'planilha atualizada', 'sincronizacao concluida', 'sincronização concluída'];

function bodyOf(message) {
  return String(message?.body ?? message?.text ?? '').trim();
}

export function isSeparator(text) {
  return SEPARATOR_RE.test(String(text ?? '').trim());
}

export function isCaseOpener(text) {
  const value = String(text ?? '').trim();
  if (!value) return false;
  const firstLine = value.split('\n')[0];
  return CASE_OPENER_RE.test(firstLine);
}

/** Cobre TODAS as mensagens emitidas pelo bot: status, erros e laudos. */
export function isBotMessage(message) {
  if (!message) return false;
  if (message.fromMe === true || message.self === true) return true;

  const text = bodyOf(message);
  if (!text) return false;

  const head = text.slice(0, 4);
  if (BOT_PREFIXES.some((prefix) => head.startsWith(prefix))) return true;

  const lower = text.toLowerCase();
  return BOT_PHRASES.some((phrase) => lower.includes(phrase));
}

/** Detecta que uma analise foi concluida com sucesso naquele chat. */
export function isSuccessfulAnalysis(message) {
  const lower = bodyOf(message).toLowerCase();
  if (!lower) return false;
  return SUCCESS_MARKERS.some((marker) => lower.includes(marker));
}

function newBlock() {
  return { messages: [], _alreadyAnalyzed: false };
}

function closeBlock(block, blocks) {
  if (block && block.messages.length) blocks.push(block);
  return null;
}

/**
 * @param {Array<{body?:string, fromMe?:boolean, timestamp?:number, id?:string}>} messages
 * @returns {Array<{messages:Array, text:string, _alreadyAnalyzed:boolean}>}
 */
export function splitIntoCases(messages = []) {
  const blocks = [];
  let current = null;
  let prebuffer = newBlock();

  for (const message of messages) {
    if (isBotMessage(message)) {
      if (isSuccessfulAnalysis(message)) {
        // Tudo que chegou ate aqui ja foi analisado. current e prebuffer guardam a
        // marca para entrarem em `blocks` ja sinalizados quando forem fechados.
        for (const block of blocks) block._alreadyAnalyzed = true;
        if (current) current._alreadyAnalyzed = true;
        prebuffer._alreadyAnalyzed = true;
      }
      continue;
    }

    const text = bodyOf(message);
    const hasMedia = Boolean(message?.media || message?.mediaUrl);
    if (!text && !hasMedia) continue;

    if (isSeparator(text)) {
      current = closeBlock(current, blocks);
      continue;
    }

    if (isCaseOpener(text)) {
      current = closeBlock(current, blocks);
      current = newBlock();
      // conteudo solto antes do primeiro abridor pertence a este caso
      if (prebuffer.messages.length) {
        current.messages.push(...prebuffer.messages);
        current._alreadyAnalyzed = prebuffer._alreadyAnalyzed;
        prebuffer = newBlock();
      }
      current.messages.push(message);
      continue;
    }

    const target = current || prebuffer;
    target.messages.push(message);
    // conteudo novo depois de uma analise reabre o bloco
    target._alreadyAnalyzed = false;
  }

  closeBlock(current, blocks);
  if (prebuffer.messages.length) blocks.push(prebuffer);

  return blocks.map((block) => ({
    ...block,
    text: block.messages.map(bodyOf).filter(Boolean).join('\n'),
  }));
}

/** Casos que ainda nao foram analisados. */
export function pendingCases(messages = []) {
  return splitIntoCases(messages).filter((block) => !block._alreadyAnalyzed);
}
