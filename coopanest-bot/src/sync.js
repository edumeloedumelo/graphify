import { getConfig, doctorByName } from './config.js';
import { scrapeCases } from './coopanest.js';
import { loadSnapshot, saveSnapshot } from './snapshot.js';
import { diffSnapshot, describeChange, caseKey } from './diff.js';
import { computeSalary } from './salary.js';
import { nowStamp } from './format.js';
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

/** Compara os casos lidos com o snapshot, grava na planilha e persiste a leitura. */
export async function applyCases(rawCases = []) {
  const cfg = getConfig();
  const incoming = rawCases.map(attachDoctor);
  const previous = loadSnapshot();
  const { added, updated, unchanged, merged } = diffSnapshot(previous, incoming);

  const warnings = [];
  let sheet = null;
  let salary = null;
  let resumoPlanilha = null;

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
      resumoPlanilha = await sheets.writeSummary();
    } catch (err) {
      warnings.push(`planilha: ${err.message}`);
      console.error('[sync] erro na planilha:', err);
    }
  } else {
    warnings.push('Google Sheets nao configurado (GOOGLE_SHEET_ID / GOOGLE_SERVICE_ACCOUNT_JSON)');
  }

  saveSnapshot(merged);

  return { added, updated, unchanged, merged, warnings, sheet, salary, resumoPlanilha };
}

/** Resumo em texto do que mudou — vai para o log e para GET /status. */
export function formatReport({ added = [], updated = [], unchanged = 0, timestamp }) {
  const lines = [`Varredura de ${timestamp}`];

  if (updated.length) {
    lines.push('', `${updated.length} cirurgia(s) com mudanca:`);
    for (const item of updated) {
      lines.push(`  ! ${caseHeadline(item)}`);
      for (const change of item.changes || []) lines.push(`      ${describeChange(change)}`);
    }
  }

  if (added.length) {
    lines.push('', `${added.length} cirurgia(s) nova(s):`);
    for (const item of added) lines.push(`  + ${caseHeadline(item)} [${item.status || 'sem status'}]`);
  }

  if (!added.length && !updated.length) lines.push('', 'Nenhuma mudanca.');
  lines.push('', `${unchanged} cirurgia(s) sem alteracao.`);

  return lines.join('\n');
}

/**
 * Varre o portal inteiro e joga o resultado na planilha.
 * As mudanças ficam marcadas com ⚠️ na coluna "Mudancas" e com a linha destacada.
 */
export async function runSync({ trigger = 'manual', force = false } = {}) {
  if (running && !force) return { skipped: true, reason: 'ja existe uma sincronizacao em andamento' };
  running = true;

  const cfg = getConfig();
  const timestamp = nowStamp(cfg.timezone);
  const startedAt = Date.now();
  const report = { trigger, timestamp, added: 0, updated: 0, unchanged: 0, warnings: [] };

  try {
    console.log(`[sync] iniciando (${trigger})`);

    const scraped = await scrapeCases();
    report.warnings.push(...scraped.warnings);
    report.pagesVisited = scraped.visited?.length || 0;
    report.pagesAnalyzed = scraped.pagesAnalyzed || 0;
    report.casesFound = scraped.cases.length;
    report.totalLinks = scraped.totalLinks;
    report.linksEncontrados = scraped.linksEncontrados;
    report.linksIgnorados = scraped.linksIgnorados;

    const applied = await applyCases(scraped.cases);
    report.added = applied.added.length;
    report.updated = applied.updated.length;
    report.unchanged = applied.unchanged.length;
    report.sheet = applied.sheet;
    report.planilha = applied.resumoPlanilha;
    report.warnings.push(...applied.warnings);
    report.changes = applied.updated.map((item) => ({
      paciente: item.paciente,
      data: item.data,
      changes: (item.changes || []).map(describeChange),
    }));

    if (applied.salary) {
      report.salary = {
        total: applied.salary.totals.salary,
        count: applied.salary.totals.count,
        months: applied.salary.months.length,
      };
    }

    report.durationSeconds = Math.round((Date.now() - startedAt) / 1000);
    setValue('lastSync', {
      at: timestamp,
      trigger,
      added: report.added,
      updated: report.updated,
      unchanged: report.unchanged,
      pagesVisited: report.pagesVisited,
      casesFound: report.casesFound,
      durationSeconds: report.durationSeconds,
      warnings: report.warnings,
      totalLinks: report.totalLinks,
      linksEncontrados: report.linksEncontrados,
      linksIgnorados: report.linksIgnorados,
      planilha: report.planilha,
    });

    console.log(
      formatReport({ added: applied.added, updated: applied.updated, unchanged: report.unchanged, timestamp }),
    );
    console.log(
      `[sync] fim em ${report.durationSeconds}s — ${report.pagesVisited} pagina(s) visitada(s), ` +
        `${report.casesFound} cirurgia(s) lida(s): ${report.added} nova(s), ${report.updated} atualizada(s)`,
    );
    if (report.warnings.length) console.warn('[sync] avisos:', report.warnings);

    return report;
  } catch (err) {
    console.error('[sync] erro:', err);
    report.error = err.message;
    setValue('lastSync', { at: timestamp, trigger, error: err.message });
    return report;
  } finally {
    running = false;
  }
}
