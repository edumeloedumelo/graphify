// Roteia mensagens recebidas: comandos ("/"), respostas a registros pendentes
// e detecção automática de registros de procedimento.
import { isMedicalRecord, extractRecord, missingFields, missingFieldsLabels } from './extractor.js';
import { handleCommand, lookupValue } from './commands.js';
import { appendRecord } from './sheets.js';
import { loadConfig, getPending, setPending } from './state.js';
import { sendMessage, parseWebhook, bareNumber } from './ultramsg.js';
import { confirmRegistration, askMissingFields } from './format.js';

const PENDING_TTL_MS = 30 * 60 * 1000; // descarta pendências com mais de 30min

function chatAllowed(chatId) {
  const allowed = (process.env.ALLOWED_CHATS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (!allowed.length) return true; // vazio = todos
  return allowed.some((a) => a === chatId || bareNumber(a) === bareNumber(chatId));
}

export async function handleWebhook(payload) {
  const msg = parseWebhook(payload);
  if (!msg) return;
  if (msg.fromMe) return; // ignora mensagens do próprio bot
  if (!chatAllowed(msg.chatId)) {
    console.log(`[router] chat ${msg.chatId} não autorizado, ignorando`);
    return;
  }

  console.log(`[router] msg de ${msg.author} em ${msg.chatId} (${msg.body.length} chars)`);

  try {
    if (msg.body.startsWith('/')) {
      const reply = await handleCommand(msg.body, msg);
      if (reply) await sendMessage(msg.chatId, reply);
      return;
    }
    await handleFreeText(msg);
  } catch (err) {
    console.error('[router] erro ao processar mensagem:', err);
    await sendMessage(msg.chatId, '⚠️ Erro ao processar a mensagem. Tente novamente.');
  }
}

async function handleFreeText(msg) {
  const cfg = loadConfig();
  const pending = getPending(msg.chatId, msg.author);
  const pendingFresh = pending && Date.now() - pending.at < PENDING_TTL_MS;

  // Resposta a uma pergunta de campo faltante: mescla com o registro parcial.
  if (pendingFresh) {
    const merged = await extractRecord(msg.body, {
      extraPrompt: cfg.extraPrompt,
      existing: pending.record,
    });
    if (merged) {
      // nunca deixa a resposta apagar o que já estava preenchido
      for (const key of Object.keys(pending.record)) {
        if (!merged[key] && pending.record[key]) merged[key] = pending.record[key];
      }
      await finalizeRecord(msg, merged);
      return;
    }
  }

  // Detecção automática: sem resposta quando não parece registro (não polui o grupo).
  if (!isMedicalRecord(msg.body)) return;

  console.log('[router] possível registro detectado, extraindo...');
  const record = await extractRecord(msg.body, { extraPrompt: cfg.extraPrompt });
  if (!record) return;

  // Se o Claude não achou nada substancial, era falso positivo da heurística.
  if (missingFields(record).length >= 4) return;

  await finalizeRecord(msg, record);
}

async function finalizeRecord(msg, record) {
  const missing = missingFields(record);
  if (missing.length) {
    setPending(msg.chatId, msg.author, record);
    await sendMessage(msg.chatId, askMissingFields(missingFieldsLabels(record)));
    return;
  }

  setPending(msg.chatId, msg.author, null);

  // Lookup interno do valor — inserido na planilha, jamais na resposta.
  const valor = lookupValue(record.procedimento);
  console.log(`[router] registrando "${record.procedimento}" (valor ${valor != null ? 'encontrado' : 'em branco'})`);

  await appendRecord(record, valor);
  await sendMessage(msg.chatId, confirmRegistration(record));
}
