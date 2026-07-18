// commands.js — comandos do WhatsApp (consulta + gestão admin).
// Valores monetários aparecem SOMENTE nos comandos de gestão admin
// (/valores, /setvalor), nunca em relatórios de procedimentos.

import { getConfig, saveConfig, getState, resetChat } from './state.js';
import { getRegistrosDoMes } from './sheets.js';
import {
  formatRelatorio, formatAnestesista, formatAjuda, monthLabel,
} from './format.js';

function currentMonthKey() {
  const fmt = new Intl.DateTimeFormat('pt-BR', {
    timeZone: 'America/Sao_Paulo', month: '2-digit', year: 'numeric',
  });
  const parts = fmt.formatToParts(new Date());
  const m = parts.find((p) => p.type === 'month').value;
  const y = parts.find((p) => p.type === 'year').value;
  return `${m}/${y}`;
}

function normalize(s) {
  return String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
}

const ADMIN_ONLY = '🔒 Comando restrito a administradores.';

export async function handleCommand(body, { isAdmin }) {
  const trimmed = body.trim();
  const space = trimmed.search(/\s/);
  const cmd = (space === -1 ? trimmed : trimmed.slice(0, space)).toLowerCase();
  const arg = space === -1 ? '' : trimmed.slice(space + 1).trim();

  console.log(`[commands] ${cmd} (admin=${isAdmin})`);

  switch (cmd) {
    // ---- consulta ----
    case '/relatorio': {
      const mes = currentMonthKey();
      return formatRelatorio(mes, await getRegistrosDoMes(mes));
    }

    case '/mes': {
      const m = arg.match(/^(\d{1,2})\/(\d{4})$/);
      if (!m) return '⚠️ Uso: /mes MM/YYYY (ex: /mes 07/2025)';
      const mes = `${m[1].padStart(2, '0')}/${m[2]}`;
      return formatRelatorio(mes, await getRegistrosDoMes(mes));
    }

    case '/anestesista': {
      if (!arg) return '⚠️ Uso: /anestesista [nome] (ex: /anestesista Carlos)';
      const mes = currentMonthKey();
      const registros = await getRegistrosDoMes(mes);
      const alvo = normalize(arg);
      const doAnestesista = registros.filter((r) => normalize(r.anestesista).includes(alvo));
      if (!doAnestesista.length) {
        return `🔍 Nenhum procedimento de "${arg}" em ${monthLabel(mes)}.`;
      }
      return formatAnestesista(doAnestesista[0].anestesista, mes, doAnestesista);
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

    // ---- gestão de valores (admin) ----
    case '/setvalor': {
      if (!isAdmin) return ADMIN_ONLY;
      const parts = arg.split(';');
      if (parts.length !== 2) return '⚠️ Uso: /setvalor Procedimento; 2800';
      const procedure = parts[0].trim();
      const value = Number(parts[1].trim().replace(/\./g, '').replace(',', '.'));
      if (!procedure || Number.isNaN(value) || value < 0) {
        return '⚠️ Uso: /setvalor Procedimento; 2800';
      }
      const config = getConfig();
      const existing = config.procedureValues.find((p) => normalize(p.procedure) === normalize(procedure));
      if (existing) {
        existing.value = value;
      } else {
        config.procedureValues.push({ procedure, value });
      }
      saveConfig();
      return `✅ Valor de *${procedure}* ${existing ? 'atualizado' : 'cadastrado'}.`;
    }

    case '/delvalor': {
      if (!isAdmin) return ADMIN_ONLY;
      if (!arg) return '⚠️ Uso: /delvalor Procedimento';
      const config = getConfig();
      const before = config.procedureValues.length;
      config.procedureValues = config.procedureValues.filter(
        (p) => normalize(p.procedure) !== normalize(arg),
      );
      if (config.procedureValues.length === before) {
        return `🔍 Procedimento "${arg}" não encontrado.`;
      }
      saveConfig();
      return `🗑️ Valor de *${arg}* removido.`;
    }

    case '/valores': {
      if (!isAdmin) return ADMIN_ONLY;
      const config = getConfig();
      if (!config.procedureValues.length) return '📋 Nenhum valor cadastrado.';
      const lines = ['📋 *Valores cadastrados*'];
      for (const p of [...config.procedureValues].sort((a, b) => a.procedure.localeCompare(b.procedure))) {
        lines.push(`  • ${p.procedure}: R$${Number(p.value).toLocaleString('pt-BR')}`);
      }
      if (config.defaultValue !== null && config.defaultValue !== undefined) {
        lines.push('');
        lines.push(`Valor padrão: R$${Number(config.defaultValue).toLocaleString('pt-BR')}`);
      }
      return lines.join('\n');
    }

    case '/setvalorpadrao': {
      if (!isAdmin) return ADMIN_ONLY;
      const config = getConfig();
      if (normalize(arg) === 'off' || normalize(arg) === 'nenhum') {
        config.defaultValue = null;
        saveConfig();
        return '✅ Valor padrão desativado.';
      }
      const value = Number(arg.replace(/\./g, '').replace(',', '.'));
      if (Number.isNaN(value) || value < 0) return '⚠️ Uso: /setvalorpadrao 1500 (ou "off")';
      config.defaultValue = value;
      saveConfig();
      return '✅ Valor padrão atualizado.';
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
