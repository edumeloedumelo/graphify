// router.js — roteia mensagens recebidas: comandos "/..." vs detecção
// automática de registros financeiros vs complemento de registro pendente.

import crypto from 'crypto';
import { sendMessage } from './ultramsg.js';
import { handleCommand, handleResetar } from './commands.js';
import {
  isFinancialRecord, extractRecord, missingFields, normalizePayment,
} from './extractor.js';
import { appendRegistro, updatePagamento } from './sheets.js';
import {
  formatRegistroConfirmado, formatPagamentoAtualizado, formatCamposFaltando,
} from './format.js';
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

async function saveNewRecord(chatId, sender, extracted) {
  const norm = normalizePayment(extracted);
  const registro = {
    data: norm.data,
    paciente: norm.paciente,
    procedimento: norm.procedimento,
    convenio: norm.convenio,
    valor: Number(norm.valor),
    valorPago: norm.valor_pago,
    glosa: norm.valor_glosado,
    status: norm.status_pagamento,
    observacoes: norm.observacoes,
    id: crypto.randomUUID().slice(0, 8),
  };

  console.log(`[router] registrando ${registro.id}: ${registro.paciente} ${registro.data} (${registro.status})`);
  await appendRegistro(registro);
  clearPending(chatId, sender);
  await sendMessage(chatId, formatRegistroConfirmado(registro));
}

async function applyPaymentUpdate(chatId, sender, extracted) {
  const updated = await updatePagamento(extracted.paciente, {
    status: extracted.status_pagamento || null,
    valorPago: extracted.valor_pago ?? null,
    glosa: extracted.valor_glosado ?? null,
    observacoes: extracted.observacoes || null,
  });
  clearPending(chatId, sender);
  if (!updated) {
    await sendMessage(chatId, `🔍 Não encontrei registro do paciente "${extracted.paciente}" para atualizar. Se for um atendimento novo, envie também data e valor.`);
    return;
  }
  await sendMessage(chatId, formatPagamentoAtualizado(updated));
}

async function processExtraction(chatId, sender, extracted) {
  if (extracted.tipo === 'atualizacao') {
    if (!extracted.paciente) {
      setPending(chatId, sender, extracted);
      await sendMessage(chatId, formatCamposFaltando(['nome do paciente']));
      return;
    }
    await applyPaymentUpdate(chatId, sender, extracted);
    return;
  }

  const missing = missingFields(extracted);
  if (missing.length) {
    setPending(chatId, sender, extracted);
    await sendMessage(chatId, formatCamposFaltando(missing));
    return;
  }
  await saveNewRecord(chatId, sender, extracted);
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
      const merged = await extractRecord(text, pending);
      if (!merged.e_registro) {
        // usuário mudou de assunto — descarta a pendência silenciosamente
        clearPending(chatId, sender);
        return;
      }
      await processExtraction(chatId, sender, merged);
      return;
    }

    // ---- detecção automática de registro ----
    if (!isFinancialRecord(text)) return; // ignora silenciosamente

    const extracted = await extractRecord(text);
    if (!extracted.e_registro) {
      console.log('[router] Claude classificou como não-registro, ignorando');
      return;
    }
    await processExtraction(chatId, sender, extracted);
  } catch (err) {
    console.error('[router] erro ao processar mensagem:', err);
    await sendMessage(chatId, '❌ Erro ao processar. Tente novamente em instantes.');
  }
}
