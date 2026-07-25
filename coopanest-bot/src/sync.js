import { getConfig, getDoctors, doctorByName } from './config.js';
import { scrapeCases } from './coopanest.js';
import { loadSnapshot, saveSnapshot } from './snapshot.js';
import { diffSnapshot, describeChange, caseKey } from './diff.js';
import { computeSalary, formatSalaryReport } from './salary.js';
import { sendText } from './ultramsg.js';
import { nowStamp, formatBRL } from './format.js';
import { setValue, getValue } from './state.js';
import * as sheets from './sheets.js';

let running = false;

export function isSyncRunning() {
  return running;
}

export function lastSyncInfo() {
  return getValue('lastSync', null);
}

function attachDoctor(item) {
  const doctor = doctorByName(item.medico) || doctorByName(item.observacoes);
  return {
    ...item,
    id: item.id || caseKey(item),
    doctorId: doctor?.id || '',
    medico: item.medico || doctor?.name || '',
  };
}

function caseHeadline(item) {
  return [item.paciente || 'paciente não identificado', item.procedimento, item.data].filter(Boolean).join(' — ');
}

/**
 * Compara os casos recebidos com o snapshot, grava na planilha e persiste.
 * Usado tanto pela varredura do portal quanto pelo /analisar do grupo.
 */
export async function applyCases(rawCases = []) {
  const cfg = getConfig();
  const incoming = rawCases.map(attachDoctor);
  const previous = loadSnapshot();
  const { added, updated, unchanged, merged } = diffSnapshot(previous, incoming);

  const warnings = [];
  let sheet = null;
  let salary = null;
  let salaryReport = '';

  if (sheets.sheetsEnabled()) {
    try {
      sheet = await sheets.upsertCases({ added, updated });

      const history = updated.flatMap((item) =>
        (item.changes || []).map((change) => ({
          id: item.id,
          medico: item.medico,
          paciente: item.paciente,
          field: change.field,
          from: change.from,
          to: change.to,
        })),
      );
      await sheets.appendHistory(history);

      salary = computeSalary(Object.values(merged), cfg);
      await sheets.writeSalary(salary);
      salaryReport = formatSalaryReport(salary, cfg);
    } catch (err) {
      warnings.push(`planilha: ${err.message}`);
      console.error('[sync] erro na planilha:', err);
    }
  } else {
    warnings.push('Google Sheets nao configurado (GOOGLE_SHEET_ID / GOOGLE_SERVICE_ACCOUNT_JSON)');
  }

  saveSnapshot(merged);

  return { added, updated, unchanged, merged, warnings, sheet, salary, salaryReport };
}

/** Mensagem enviada para o grupo de um medico. */
export function formatDoctorReport({ doctor, added = [], updated = [], cfg = getConfig(), timestamp }) {
  const limit = cfg.sync?.maxChangesPerMessage || 15;
  const stamp = timestamp || nowStamp(cfg.timezone);
  const lines = [`🔄 *Coopanest Rio* — ${stamp}`];
  if (doctor?.name) lines.push(`Grupo: ${doctor.name}`);
  lines.push('');

  if (updated.length) {
    lines.push(`⚠️ *${updated.length} cirurgia(s) com mudança*`, '');
    for (const item of updated.slice(0, limit)) {
      lines.push(`⚠️ *${caseHeadline(item)}*`);
      for (const change of item.changes || []) lines.push(`   ${describeChange(change)}`);
      lines.push('');
    }
    if (updated.length > limit) lines.push(`_(+${updated.length - limit} na planilha)_`, '');
  }

  if (added.length) {
    lines.push(`🆕 *${added.length} cirurgia(s) nova(s)*`, '');
    for (const item of added.slice(0, limit)) {
      const value = formatBRL(item.valorBruto);
      lines.push(`• *${caseHeadline(item)}*`, `   status: ${item.status || '—'}${value ? ` | bruto: ${value}` : ''}`);
    }
    if (added.length > limit) lines.push(`_(+${added.length - limit} na planilha)_`);
    lines.push('');
  }

  if (!updated.length && !added.length) lines.push('Nenhuma mudança desde a última varredura.', '');

  const url = sheets.sheetUrl();
  if (url) lines.push(`📊 Planilha: ${url}`);

  return lines.join('\n');
}

async function notify(chatId, text) {
  if (!chatId) return false;
  try {
    await sendText(chatId, text);
    return true;
  } catch (err) {
    console.error('[sync] falha enviando para', chatId, err.message);
    return false;
  }
}

/**
 * Varre o portal da Coopanest, atualiza a planilha e avisa os grupos.
 * @param {{trigger?:string, notifyChatId?:string, force?:boolean}} options
 */
export async function runSync({ trigger = 'manual', notifyChatId = '', force = false } = {}) {
  if (running && !force) return { skipped: true, reason: 'ja existe uma sincronizacao em andamento' };
  running = true;

  const cfg = getConfig();
  const timestamp = nowStamp(cfg.timezone);
  const report = { trigger, timestamp, added: 0, updated: 0, unchanged: 0, warnings: [], notified: [] };

  try {
    console.log(`[sync] iniciando (${trigger})`);

    const scraped = await scrapeCases();
    report.warnings.push(...scraped.warnings);
    report.pages = scraped.pages;

    const applied = await applyCases(scraped.cases);
    report.added = applied.added.length;
    report.updated = applied.updated.length;
    report.unchanged = applied.unchanged.length;
    report.sheet = applied.sheet;
    report.warnings.push(...applied.warnings);
    if (applied.salary) {
      report.salary = {
        total: applied.salary.totals.salary,
        count: applied.salary.totals.count,
        months: applied.salary.months.length,
      };
    }

    setValue('lastSync', { at: timestamp, trigger, added: report.added, updated: report.updated });

    const hasChanges = applied.added.length > 0 || applied.updated.length > 0;
    const adminChat = process.env.CHAT_ADMIN || '';
    const targets = new Map();

    for (const doctor of getDoctors()) {
      if (!doctor.chatId) continue;
      targets.set(doctor.chatId, {
        doctor,
        added: applied.added.filter((item) => item.doctorId === doctor.id),
        updated: applied.updated.filter((item) => item.doctorId === doctor.id),
      });
    }

    // casos sem medico identificado nao somem: vao no resumo geral
    const orphanAdded = applied.added.filter((item) => !item.doctorId);
    const orphanUpdated = applied.updated.filter((item) => !item.doctorId);

    if (adminChat) {
      targets.set(adminChat, {
        doctor: { name: 'Resumo geral' },
        added: orphanAdded,
        updated: orphanUpdated,
        isAdmin: true,
      });
    }

    if (notifyChatId && !targets.has(notifyChatId)) {
      targets.set(notifyChatId, { doctor: null, added: applied.added, updated: applied.updated, isAdmin: true });
    }

    for (const [chatId, payload] of targets) {
      const changed = payload.added.length > 0 || payload.updated.length > 0;
      const mustSend = chatId === notifyChatId || cfg.sync?.notifyWhenNoChanges;
      if (!changed && !mustSend) continue;

      let text = formatDoctorReport({ ...payload, cfg, timestamp });
      if (payload.isAdmin && applied.salaryReport) text += `\n\n${applied.salaryReport}`;
      if (payload.isAdmin && report.warnings.length) {
        text += `\n\n⚠️ _Avisos:_\n${report.warnings.map((warning) => `• ${warning}`).join('\n')}`;
      }

      if (await notify(chatId, text)) report.notified.push(chatId);
    }

    if (!hasChanges) console.log('[sync] nenhuma mudanca detectada');
    console.log(`[sync] fim — ${report.added} novo(s), ${report.updated} atualizado(s), ${report.unchanged} igual(is)`);
    return report;
  } catch (err) {
    console.error('[sync] erro:', err);
    report.error = err.message;
    if (notifyChatId) await notify(notifyChatId, `❌ Erro na sincronização: ${err.message}`);
    return report;
  } finally {
    running = false;
  }
}
