// commands.js — comandos do WhatsApp (consulta + gestão admin).
// `ctx` traz: { isAdmin, ssid, groupName, chatId }.

import { getConfig, saveConfig, getState, resetChat } from './state.js';
import { getRegistros, getRegistrosDoMes, getRegistrosDoPaciente } from './sheets.js';
import { getSaraConfig } from './sara.js';
import {
  formatRelatorio, formatPaciente, formatPendentes, formatSara, formatAjuda,
} from './format.js';

function normName(s) {
  return String(s)
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/\bdr[a]?\b\.?/g, '') // remove títulos "dr"/"dra"
    .replace(/[^\p{L}\p{N}\s]/gu, ' ') // remove pontuação
    .replace(/\s+/g, ' ')
    .trim();
}

// Mesma leniência do casamento de cirurgião/clínica: um contém o outro.
function sameEntry(a, b) {
  const na = normName(a);
  const nb = normName(b);
  return Boolean(na && nb && (na === nb || na.includes(nb) || nb.includes(na)));
}

// Garante que config.sara exista e devolve a referência para edição.
function ensureSaraConfig() {
  const config = getConfig();
  if (!config.sara) config.sara = { ...getSaraConfig() };
  if (!Array.isArray(config.sara.surgeons)) config.sara.surgeons = [...getSaraConfig().surgeons];
  if (!Array.isArray(config.sara.clinics)) config.sara.clinics = [...getSaraConfig().clinics];
  return config.sara;
}

function currentMonthKey() {
  const fmt = new Intl.DateTimeFormat('pt-BR', {
    timeZone: 'America/Sao_Paulo', month: '2-digit', year: 'numeric',
  });
  const parts = fmt.formatToParts(new Date());
  const m = parts.find((p) => p.type === 'month').value;
  const y = parts.find((p) => p.type === 'year').value;
  return `${m}/${y}`;
}

const ADMIN_ONLY = '🔒 Comando restrito a administradores.';

export async function handleCommand(body, ctx) {
  const { isAdmin, ssid, groupName, chatId } = ctx;
  const trimmed = body.trim();
  const space = trimmed.search(/\s/);
  const cmd = (space === -1 ? trimmed : trimmed.slice(0, space)).toLowerCase();
  const arg = space === -1 ? '' : trimmed.slice(space + 1).trim();

  console.log(`[commands] ${cmd} (admin=${isAdmin}, grupo=${groupName || '?'})`);

  switch (cmd) {
    // ---- descoberta do ID do grupo (bootstrap da configuração) ----
    case '/id':
      return [
        '🆔 *ID deste grupo*',
        `\`${chatId}\``,
        '',
        groupName
          ? `Configurado como: *${groupName}*`
          : '_Ainda não configurado._ Copie o ID acima e cole na variável GROUP_n_CHAT no Railway.',
      ].join('\n');

    // ---- consulta ----
    case '/relatorio': {
      const mes = currentMonthKey();
      return formatRelatorio(mes, await getRegistrosDoMes(ssid, mes), groupName);
    }

    case '/mes': {
      const m = arg.match(/^(\d{1,2})\/(\d{4})$/);
      if (!m) return '⚠️ Uso: /mes MM/YYYY (ex: /mes 07/2025)';
      const mes = `${m[1].padStart(2, '0')}/${m[2]}`;
      return formatRelatorio(mes, await getRegistrosDoMes(ssid, mes), groupName);
    }

    case '/paciente': {
      if (!arg) return '⚠️ Uso: /paciente [nome] (ex: /paciente Maria)';
      const registros = await getRegistrosDoPaciente(ssid, arg);
      if (!registros.length) return `🔍 Nenhum registro encontrado para "${arg}".`;
      return formatPaciente(registros[0].paciente, registros);
    }

    case '/pendentes':
      return formatPendentes(await getRegistros(ssid));

    case '/sara': {
      let mes = currentMonthKey();
      if (arg) {
        const m = arg.match(/^(\d{1,2})\/(\d{4})$/);
        if (!m) return '⚠️ Uso: /sara ou /sara MM/YYYY';
        mes = `${m[1].padStart(2, '0')}/${m[2]}`;
      }
      return formatSara(mes, await getRegistrosDoMes(ssid, mes));
    }

    case '/status': {
      const { lastSync } = getState();
      if (!lastSync) return '📡 Nenhuma sincronização com a planilha ainda.';
      const when = new Date(lastSync).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
      return `📡 Última sincronização com a planilha: *${when}*`;
    }

    case '/ajuda':
    case '/help':
      return formatAjuda(isAdmin);

    // ---- gestão da comissão da Sara (admin) ----
    case '/saraconfig': {
      if (!isAdmin) return ADMIN_ONLY;
      const s = getSaraConfig();
      return [
        '👩‍💼 *Comissão da Sara — configuração*',
        `Comissão: ${Math.round(s.commissionRate * 100)}% do líquido`,
        `Imposto: ${Math.round(s.taxRate * 100)}%`,
        `Base: ${s.basis === 'recebido' ? 'valor recebido' : 'valor faturado (bruto)'}`,
        '',
        `Cirurgiões: ${s.surgeons.length ? s.surgeons.join(', ') : '(nenhum)'}`,
        `Clínicas: ${s.clinics.length ? s.clinics.join(', ') : '(nenhuma)'}`,
      ].join('\n');
    }

    case '/addcirurgiao': {
      if (!isAdmin) return ADMIN_ONLY;
      if (!arg) return '⚠️ Uso: /addcirurgiao Nome do Cirurgião';
      const sara = ensureSaraConfig();
      if (sara.surgeons.some((x) => sameEntry(x, arg))) {
        return `ℹ️ "${arg}" já está na lista.`;
      }
      sara.surgeons.push(arg.trim());
      saveConfig();
      return `✅ Cirurgião *${arg.trim()}* incluído na comissão da Sara.`;
    }

    case '/delcirurgiao': {
      if (!isAdmin) return ADMIN_ONLY;
      if (!arg) return '⚠️ Uso: /delcirurgiao Nome do Cirurgião';
      const sara = ensureSaraConfig();
      const before = sara.surgeons.length;
      sara.surgeons = sara.surgeons.filter((x) => !sameEntry(x, arg));
      if (sara.surgeons.length === before) return `🔍 "${arg}" não estava na lista.`;
      saveConfig();
      return `🗑️ Cirurgião *${arg.trim()}* removido.`;
    }

    case '/addclinica': {
      if (!isAdmin) return ADMIN_ONLY;
      if (!arg) return '⚠️ Uso: /addclinica Nome da Clínica';
      const sara = ensureSaraConfig();
      if (sara.clinics.some((x) => sameEntry(x, arg))) {
        return `ℹ️ "${arg}" já está na lista.`;
      }
      sara.clinics.push(arg.trim());
      saveConfig();
      return `✅ Clínica *${arg.trim()}* incluída na comissão da Sara.`;
    }

    case '/delclinica': {
      if (!isAdmin) return ADMIN_ONLY;
      if (!arg) return '⚠️ Uso: /delclinica Nome da Clínica';
      const sara = ensureSaraConfig();
      const before = sara.clinics.length;
      sara.clinics = sara.clinics.filter((x) => !sameEntry(x, arg));
      if (sara.clinics.length === before) return `🔍 "${arg}" não estava na lista.`;
      saveConfig();
      return `🗑️ Clínica *${arg.trim()}* removida.`;
    }

    // ---- gestão geral (admin) ----
    case '/setprompt': {
      if (!isAdmin) return ADMIN_ONLY;
      if (!arg) return '⚠️ Uso: /setprompt [texto da instrução extra]';
      const config = getConfig();
      config.extraPrompt = arg;
      saveConfig();
      return '✅ Instrução extra do extrator atualizada.';
    }

    case '/limparprompt': {
      if (!isAdmin) return ADMIN_ONLY;
      const config = getConfig();
      config.extraPrompt = '';
      saveConfig();
      return '✅ Instrução extra removida.';
    }

    case '/resetar': {
      if (!isAdmin) return ADMIN_ONLY;
      return null; // tratado no router (precisa do chatId)
    }

    default:
      return `❓ Comando desconhecido: ${cmd}\nDigite /ajuda para ver os comandos.`;
  }
}

export function handleResetar(chatId) {
  resetChat(chatId);
  return '🔄 Posição de leitura do grupo resetada.';
}
