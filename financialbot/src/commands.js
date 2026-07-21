// commands.js — comandos do WhatsApp (consulta + gestão admin).

import { getConfig, saveConfig, getState, resetChat } from './state.js';
import { getRegistros, getRegistrosDoMes, getRegistrosDoPaciente } from './sheets.js';
import {
  formatRelatorio, formatPaciente, formatPendentes, formatAjuda, monthLabel,
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

    case '/paciente': {
      if (!arg) return '⚠️ Uso: /paciente [nome] (ex: /paciente Maria)';
      const registros = await getRegistrosDoPaciente(arg);
      if (!registros.length) return `🔍 Nenhum registro encontrado para "${arg}".`;
      return formatPaciente(registros[0].paciente, registros);
    }

    case '/pendentes':
      return formatPendentes(await getRegistros());

    case '/status': {
      const { lastSync } = getState();
      if (!lastSync) return '📡 Nenhuma sincronização com a planilha ainda.';
      const when = new Date(lastSync).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
      return `📡 Última sincronização com a planilha: *${when}*`;
    }

    case '/ajuda':
    case '/help':
      return formatAjuda(isAdmin);

    // ---- compatibilidade: informa relatório do mês pedido por nome antigo ----
    case '/anestesista':
      return 'ℹ️ Este bot agora controla pagamentos por paciente. Use /paciente [nome].';

    // ---- gestão (admin) ----
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

export { monthLabel };
