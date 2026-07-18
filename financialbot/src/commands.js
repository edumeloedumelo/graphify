// Comandos do WhatsApp. Comandos de gestão exigem admin (ADMIN_NUMBERS).
import { loadConfig, saveConfig, loadState, saveState, setPending } from './state.js';
import { getRecordsForMonth, monthKey } from './sheets.js';
import { monthReport, anesthetistReport, helpText, monthLabel } from './format.js';
import { bareNumber } from './ultramsg.js';

function currentMonth() {
  const fmt = new Intl.DateTimeFormat('pt-BR', {
    timeZone: 'America/Sao_Paulo', month: '2-digit', year: 'numeric',
  });
  const parts = Object.fromEntries(fmt.formatToParts(new Date()).map((p) => [p.type, p.value]));
  return `${parts.month}/${parts.year}`;
}

export function isAdmin(author) {
  const admins = (process.env.ADMIN_NUMBERS || '')
    .split(',')
    .map((n) => bareNumber(n))
    .filter(Boolean);
  return admins.includes(bareNumber(author));
}

// Lookup interno de valor pelo nome do procedimento. Nunca exposto no WhatsApp.
export function lookupValue(procedimento) {
  const cfg = loadConfig();
  const needle = String(procedimento || '').trim().toLowerCase();
  if (!needle) return cfg.defaultValue ?? null;

  const exact = cfg.procedureValues.find((p) => p.procedure.toLowerCase() === needle);
  if (exact) return exact.value;

  const partial = cfg.procedureValues.find((p) => {
    const cand = p.procedure.toLowerCase();
    return cand.includes(needle) || needle.includes(cand);
  });
  if (partial) return partial.value;

  return cfg.defaultValue ?? null;
}

export async function handleCommand(text, ctx) {
  const [cmd, ...restParts] = text.trim().split(/\s+/);
  const rest = text.trim().slice(cmd.length).trim();
  const command = cmd.toLowerCase();
  const admin = isAdmin(ctx.author);

  switch (command) {
    case '/relatorio': {
      const month = currentMonth();
      const records = await getRecordsForMonth(month);
      return monthReport(month, records);
    }

    case '/mes': {
      const m = rest.match(/^(\d{1,2})\/(\d{4})$/);
      if (!m) return 'Uso: /mes MM/YYYY (ex.: /mes 07/2025)';
      const month = `${m[1].padStart(2, '0')}/${m[2]}`;
      const records = await getRecordsForMonth(month);
      return monthReport(month, records);
    }

    case '/anestesista': {
      if (!rest) return 'Uso: /anestesista [nome]';
      const month = currentMonth();
      const records = await getRecordsForMonth(month);
      const needle = rest.toLowerCase();
      const filtered = records.filter((r) => r.anestesista.toLowerCase().includes(needle));
      return anesthetistReport(rest, month, filtered);
    }

    case '/status': {
      const state = loadState();
      if (!state.lastSync) return '📡 Nenhuma sincronização com a planilha ainda.';
      const when = new Date(state.lastSync).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
      return `📡 Última sincronização com a planilha: ${when}`;
    }

    case '/ajuda':
    case '/help':
      return helpText(admin);

    // ---------- admin: valores ----------

    case '/setvalor': {
      if (!admin) return '⛔ Comando restrito a administradores.';
      const parts = rest.split(';');
      if (parts.length < 2) return 'Uso: /setvalor Nome do Procedimento; 2800';
      const name = parts[0].trim();
      const value = Number(parts[1].trim().replace(/\./g, '').replace(',', '.'));
      if (!name || !Number.isFinite(value)) return 'Uso: /setvalor Nome do Procedimento; 2800';
      const cfg = loadConfig();
      const existing = cfg.procedureValues.find((p) => p.procedure.toLowerCase() === name.toLowerCase());
      if (existing) existing.value = value;
      else cfg.procedureValues.push({ procedure: name, value });
      saveConfig(cfg);
      console.log(`[commands] valor de "${name}" ${existing ? 'atualizado' : 'cadastrado'}`);
      return `✅ Valor de *${name}* ${existing ? 'atualizado' : 'cadastrado'}.`;
    }

    case '/delvalor': {
      if (!admin) return '⛔ Comando restrito a administradores.';
      if (!rest) return 'Uso: /delvalor Nome do Procedimento';
      const cfg = loadConfig();
      const before = cfg.procedureValues.length;
      cfg.procedureValues = cfg.procedureValues.filter(
        (p) => p.procedure.toLowerCase() !== rest.toLowerCase(),
      );
      if (cfg.procedureValues.length === before) return `Procedimento *${rest}* não encontrado.`;
      saveConfig(cfg);
      return `🗑️ Valor de *${rest}* removido.`;
    }

    case '/valores': {
      if (!admin) return '⛔ Comando restrito a administradores.';
      const cfg = loadConfig();
      if (!cfg.procedureValues.length) return 'Nenhum procedimento cadastrado.';
      const lines = ['💰 *Procedimentos cadastrados*'];
      for (const p of [...cfg.procedureValues].sort((a, b) => a.procedure.localeCompare(b.procedure, 'pt-BR'))) {
        lines.push(`• ${p.procedure}: R$${Number(p.value).toLocaleString('pt-BR')}`);
      }
      if (cfg.defaultValue != null) {
        lines.push(`\nValor padrão: R$${Number(cfg.defaultValue).toLocaleString('pt-BR')}`);
      }
      return lines.join('\n');
    }

    case '/setvalorpadrao': {
      if (!admin) return '⛔ Comando restrito a administradores.';
      const cfg = loadConfig();
      if (/^(off|nenhum|remover)$/i.test(rest)) {
        cfg.defaultValue = null;
        saveConfig(cfg);
        return '✅ Valor padrão removido.';
      }
      const value = Number(rest.replace(/\./g, '').replace(',', '.'));
      if (!Number.isFinite(value)) return 'Uso: /setvalorpadrao 1500 (ou /setvalorpadrao off)';
      cfg.defaultValue = value;
      saveConfig(cfg);
      return '✅ Valor padrão configurado.';
    }

    // ---------- admin: gestão ----------

    case '/setprompt': {
      if (!admin) return '⛔ Comando restrito a administradores.';
      if (!rest) return 'Uso: /setprompt [instrução extra para o extrator]';
      const cfg = loadConfig();
      cfg.extraPrompt = rest;
      saveConfig(cfg);
      return '✅ Instrução extra do extrator configurada.';
    }

    case '/limparprompt': {
      if (!admin) return '⛔ Comando restrito a administradores.';
      const cfg = loadConfig();
      cfg.extraPrompt = '';
      saveConfig(cfg);
      return '✅ Instrução extra removida.';
    }

    case '/resetar': {
      if (!admin) return '⛔ Comando restrito a administradores.';
      const state = loadState();
      state.pending = {};
      saveState(state);
      setPending(ctx.chatId, ctx.author, null);
      return '🔄 Posição de leitura do grupo resetada.';
    }

    default:
      return null; // comando desconhecido: ignora silenciosamente
  }
}
