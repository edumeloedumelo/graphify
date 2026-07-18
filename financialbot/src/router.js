// router.js — roteia mensagens recebidas: comandos "/..." vs detecção
// automática de registros de procedimento vs complemento de registro pendente.

import crypto from 'crypto';
import { sendMessage } from './ultramsg.js';
import { handleCommand, handleResetar } from './commands.js';
import {
  isMedicalRecord, extractProcedure, missingFields, lookupValue,
} from './extractor.js';
import { appendRegistro } from './sheets.js';
import { formatRegistroConfirmado, formatCamposFaltando } from './format.js';
import {
  isProcessed, markProcessed, getPending, setPending, clearPending,
} from './state.js';

function parseList(envVar) {
  return (process.env[envVar] || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function digits(s) {
  return String(s).replace(/\D/g, '');
}

function isChatAllowed(chatId) {
  const allowed = parseList('ALLOWED_CHATS');
  if (!allowed.length) return true; // vazio = todos
  return allowed.includes(chatId);
}

function isAdmin(sender) {
  const admins = parseList('ADMIN_NUMBERS').map(digits);
  const s = digits(sender);
  return admins.some((a) => a && (s === a || s.endsWith(a) || a.endsWith(s)));
}

async function registerProcedure(chatId, sender, extracted) {
  const registro = {
    data: extracted.data,
    anestesista: extracted.nome_anestesista,
    hospital: extracted.hospital,
    procedimento: extracted.procedimento,
    cirurgiao: extracted.cirurgiao,
    status: extracted.status || 'realizado',
    // Lookup interno — o valor vai para a planilha e NUNCA para o WhatsApp.
    valor: lookupValue(extracted.procedimento),
    id: crypto.randomUUID().slice(0, 8),
  };

  console.log(`[router] registrando ${registro.id}: ${registro.procedimento} (${registro.anestesista}) valor=${registro.valor !== null ? 'definido' : 'em branco'}`);
  await appendRegistro(registro);
  clearPending(chatId, sender);
  await sendMessage(chatId, formatRegistroConfirmado(registro));
}

export async function handleIncoming(msg) {
  // msg: { id, chatId, sender, body, fromMe }
  const { id, chatId, sender, body, fromMe } = msg;

  if (fromMe) return;
  if (!body || !body.trim()) return;
  if (!isChatAllowed(chatId)) {
    console.log(`[router] chat ${chatId} não autorizado, ignorando`);
    return;
  }
  if (id && isProcessed(id)) {
    console.log(`[router] mensagem ${id} já processada, ignorando`);
    return;
  }
  markProcessed(id);

  const text = body.trim();
  const admin = isAdmin(sender);

  try {
    // ---- comandos ----
    if (text.startsWith('/')) {
      if (text.toLowerCase().startsWith('/resetar')) {
        if (!admin) {
          await sendMessage(chatId, '🔒 Comando restrito a administradores.');
          return;
        }
        await sendMessage(chatId, handleResetar(chatId));
        return;
      }
      const reply = await handleCommand(text, { isAdmin: admin });
      if (reply) await sendMessage(chatId, reply);
      return;
    }

    // ---- complemento de registro pendente (campos que faltavam) ----
    const pending = getPending(chatId, sender);
    if (pending) {
      const merged = await extractProcedure(text, pending);
      if (!merged.e_registro) {
        // usuário mudou de assunto — descarta a pendência silenciosamente
        clearPending(chatId, sender);
        return;
      }
      const missing = missingFields(merged);
      if (missing.length) {
        setPending(chatId, sender, merged);
        await sendMessage(chatId, formatCamposFaltando(missing));
        return;
      }
      await registerProcedure(chatId, sender, merged);
      return;
    }

    // ---- detecção automática de registro ----
    if (!isMedicalRecord(text)) return; // ignora silenciosamente

    const extracted = await extractProcedure(text);
    if (!extracted.e_registro) {
      console.log('[router] Claude classificou como não-registro, ignorando');
      return;
    }

    const missing = missingFields(extracted);
    if (missing.length) {
      setPending(chatId, sender, extracted);
      await sendMessage(chatId, formatCamposFaltando(missing));
      return;
    }

    await registerProcedure(chatId, sender, extracted);
  } catch (err) {
    console.error('[router] erro ao processar mensagem:', err);
    await sendMessage(chatId, '❌ Erro ao processar. Tente novamente em instantes.');
  }
}
