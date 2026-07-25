import { getConfig, doctorByChatId } from './config.js';
import { fetchNewMessages, newestTimestamp } from './fetcher.js';
import { getLastTime, setLastTime } from './state.js';
import { pendingCases } from './parser.js';
import { analyzeConversationCase, dedupeCases } from './triage.js';
import { applyCases, runSync, isSyncRunning, lastSyncInfo, formatDoctorReport } from './sync.js';
import { computeSalary, formatSalaryReport } from './salary.js';
import { loadSnapshot } from './snapshot.js';
import { sendText } from './ultramsg.js';
import { toWhatsApp, nowStamp } from './format.js';
import * as sheets from './sheets.js';

/** Um /analisar por grupo de cada vez. */
const locks = new Set();

export function isLocked(chatId) {
  return locks.has(chatId);
}

function isAdmin(author = '') {
  const raw = (process.env.ADMIN_NUMBERS || '').trim();
  if (!raw) return true;
  const number = String(author).replace(/\D/g, '');
  return raw
    .split(',')
    .map((item) => item.replace(/\D/g, '').trim())
    .filter(Boolean)
    .some((admin) => number.endsWith(admin) || admin.endsWith(number));
}

export function parseCommand(text = '') {
  const match = String(text).trim().match(/^[/!](\w+)\s*(.*)$/s);
  if (!match) return null;
  return { name: match[1].toLowerCase(), args: match[2].trim() };
}

const HELP = [
  '🤖 *Coopanest Bot — comandos*',
  '',
  '*/sync* — varre o portal agora e atualiza a planilha',
  '*/status* — última varredura, casos monitorados e config',
  '*/salario* — cálculo do salário da Sara (5% do líquido)',
  '*/planilha* — link da planilha',
  '*/analisar* — lê os casos escritos aqui no grupo e joga na planilha',
  '*/ajuda* — esta mensagem',
  '',
  '_A varredura do portal roda sozinha no intervalo configurado; mudanças aparecem com ⚠️._',
].join('\n');

async function handleAnalisar({ chatId, timestamp }) {
  if (locks.has(chatId)) {
    await sendText(chatId, '🔒 Já tem uma análise rodando neste grupo. Aguarde ela terminar.');
    return;
  }
  locks.add(chatId);

  const cfg = getConfig();
  const doctor = doctorByChatId(chatId);
  const cmdTime = Number(timestamp) || Math.floor(Date.now() / 1000);
  const since = getLastTime(chatId);

  try {
    // marca ANTES de buscar: se chegarem mensagens durante a análise, elas não
    // entram nesta rodada nem se perdem — ficam para a próxima
    setLastTime(chatId, cmdTime);

    await sendText(chatId, '⏳ Analisando as mensagens novas do grupo...');

    const messages = await fetchNewMessages(chatId, since);
    if (messages.length === 0) {
      await sendText(chatId, 'ℹ️ Nenhuma mensagem nova desde a última análise.');
      return;
    }

    const blocks = pendingCases(messages);
    if (blocks.length === 0) {
      await sendText(chatId, 'ℹ️ Nenhum caso novo para analisar (as mensagens novas já haviam sido processadas).');
      return;
    }

    const collected = [];
    const warnings = [];
    const urlMissing = [];

    for (const block of blocks) {
      try {
        const result = await analyzeConversationCase({ block, doctor });
        collected.push(...result.cases);
        warnings.push(...result.warnings);
        urlMissing.push(...result.urlMissing);
      } catch (err) {
        warnings.push(`falha analisando um caso: ${err.message}`);
        console.error('[commands] erro analisando bloco:', err);
      }
    }

    if (collected.length === 0) {
      const detail = warnings.length ? `\n\n⚠️ ${warnings.join('\n⚠️ ')}` : '';
      await sendText(chatId, `❌ Não consegui extrair nenhum caso das mensagens novas.${detail}`);
      return;
    }

    const applied = await applyCases(dedupeCases(collected));
    warnings.push(...applied.warnings);

    let text = formatDoctorReport({
      doctor,
      added: applied.added,
      updated: applied.updated,
      cfg,
      timestamp: nowStamp(cfg.timezone),
    });
    text = `📋 *Resumo do caso* (${blocks.length} bloco(s) lido(s))\n\n${text}`;

    if (urlMissing.length) {
      text += `\n\n⚠️ Detectei ${urlMissing.length} arquivo(s) sem URL disponível (${[...new Set(urlMissing)].join(
        ', ',
      )}). Ative *Webhook Download Media* no UltraMsg e reenvie o arquivo.`;
    }
    if (warnings.length) {
      text += `\n\n⚠️ _Avisos:_\n${[...new Set(warnings)].map((warning) => `• ${warning}`).join('\n')}`;
    }

    await sendText(chatId, toWhatsApp(text));

    // avança o marcador para o mais recente entre o comando e as mensagens lidas
    setLastTime(chatId, Math.max(cmdTime, newestTimestamp(messages)));
  } catch (err) {
    console.error('[commands] /analisar falhou:', err);
    await sendText(chatId, `❌ Erro ao analisar: ${err.message}`).catch(() => {});
  } finally {
    locks.delete(chatId);
  }
}

async function handleSync({ chatId }) {
  if (isSyncRunning()) {
    await sendText(chatId, '🔄 Já tem uma varredura do portal rodando. Te aviso quando terminar.');
    return;
  }
  await sendText(chatId, '🔄 Varrendo o portal da Coopanest Rio...');
  await runSync({ trigger: 'comando', notifyChatId: chatId });
}

async function handleStatus({ chatId }) {
  const cfg = getConfig();
  const last = lastSyncInfo();
  const snapshot = loadSnapshot();
  const doctor = doctorByChatId(chatId);

  const lines = [
    '📊 *Status do bot*',
    '',
    `Última varredura: ${last ? `${last.at} (${last.trigger})` : 'ainda não rodou'}`,
    last ? `Resultado: ${last.added} novo(s), ${last.updated} atualizado(s)` : '',
    `Cirurgias monitoradas: ${Object.keys(snapshot).length}`,
    `Varredura automática: a cada ${process.env.SYNC_INTERVAL_MINUTES || cfg.sync?.intervalMinutes || 60} min`,
    `Planilha: ${sheets.sheetsEnabled() ? 'conectada' : '❌ não configurada'}`,
    `Portal: ${process.env.COOPANEST_USER ? 'credenciais ok' : '❌ sem credenciais'}`,
    doctor ? `Este grupo: ${doctor.name}` : 'Este grupo: não vinculado a um médico',
    isSyncRunning() ? '\n🔄 _Varredura em andamento agora._' : '',
  ].filter(Boolean);

  await sendText(chatId, lines.join('\n'));
}

async function handleSalario({ chatId }) {
  const cfg = getConfig();
  const snapshot = loadSnapshot();
  const summary = computeSalary(Object.values(snapshot), cfg);
  await sendText(chatId, formatSalaryReport(summary, cfg));
}

async function handlePlanilha({ chatId }) {
  const url = sheets.sheetUrl();
  await sendText(
    chatId,
    url ? `📊 Planilha das cirurgias:\n${url}` : '❌ GOOGLE_SHEET_ID não configurada no Railway.',
  );
}

/**
 * Roteia um comando recebido de um grupo.
 * @returns {Promise<boolean>} true se o comando foi reconhecido
 */
export async function handleCommand({ chatId, text, author, timestamp }) {
  const command = parseCommand(text);
  if (!command) return false;

  if (!isAdmin(author)) {
    await sendText(chatId, '🔒 Só administradores podem usar comandos aqui.');
    return true;
  }

  switch (command.name) {
    case 'ajuda':
    case 'help':
    case 'comandos':
      await sendText(chatId, HELP);
      return true;

    case 'sync':
    case 'sincronizar':
    case 'atualizar':
      await handleSync({ chatId });
      return true;

    case 'status':
      await handleStatus({ chatId });
      return true;

    case 'salario':
    case 'sara':
      await handleSalario({ chatId });
      return true;

    case 'planilha':
    case 'sheet':
      await handlePlanilha({ chatId });
      return true;

    case 'analisar':
      await handleAnalisar({ chatId, timestamp });
      return true;

    default:
      await sendText(chatId, `❓ Comando desconhecido: /${command.name}\n\n${HELP}`);
      return true;
  }
}
