import { google } from 'googleapis';

import { getConfig } from './config.js';
import { normalize, nowStamp } from './format.js';
import { describeChanges } from './diff.js';

const SCOPES = ['https://www.googleapis.com/auth/spreadsheets'];

let clientPromise = null;

function credentials() {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON nao configurada');

  const text = raw.trim().startsWith('{') ? raw : Buffer.from(raw, 'base64').toString('utf8');
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON nao e um JSON valido (cole o JSON inteiro ou o base64 dele)');
  }
  if (parsed.private_key) parsed.private_key = parsed.private_key.replace(/\\n/g, '\n');
  return parsed;
}

export function spreadsheetId() {
  const id = process.env.GOOGLE_SHEET_ID;
  if (!id) throw new Error('GOOGLE_SHEET_ID nao configurada');
  return id;
}

export function sheetUrl() {
  try {
    return `https://docs.google.com/spreadsheets/d/${spreadsheetId()}`;
  } catch {
    return '';
  }
}

export function sheetsEnabled() {
  return Boolean(process.env.GOOGLE_SHEET_ID && process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
}

/** E-mail da service account, sem estourar erro se o JSON estiver quebrado. */
export function serviceAccountEmail() {
  try {
    return credentials().client_email || '';
  } catch {
    return '';
  }
}

/**
 * Confere se a planilha está acessível e devolve o diagnóstico — nunca lança.
 * Roda no boot para o problema aparecer no /health em vez de só na 1a varredura.
 */
export async function verifyAccess() {
  if (!process.env.GOOGLE_SHEET_ID) {
    return { ok: false, motivo: 'GOOGLE_SHEET_ID nao configurada' };
  }
  if (!process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
    return { ok: false, motivo: 'GOOGLE_SERVICE_ACCOUNT_JSON nao configurada' };
  }

  const email = serviceAccountEmail();
  if (!email) {
    // mostra tamanho e inicio do que chegou — diz na hora se veio truncado,
    // se e base64 ou se o JSON foi cortado na primeira quebra de linha
    const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON.trim();
    const amostra = raw.slice(0, 14).replace(/[^\x20-\x7E]/g, '?');
    const linhas = raw.split('\n').length;
    return {
      ok: false,
      motivo:
        `GOOGLE_SERVICE_ACCOUNT_JSON invalida — recebi ${raw.length} caractere(s) em ${linhas} linha(s), ` +
        `comecando com "${amostra}…". O valor certo comeca com {"type":"service_account" (JSON inteiro) ` +
        'ou com "ewog" (base64). Um JSON completo tem ~2300 caracteres.',
    };
  }

  try {
    const client = await getClient();
    const { data } = await client.spreadsheets.get({ spreadsheetId: spreadsheetId() });
    return {
      ok: true,
      planilha: data.properties?.title || '',
      abas: (data.sheets || []).map((sheet) => sheet.properties.title),
      serviceAccount: email,
    };
  } catch (err) {
    const status = err.status || err.code;
    let motivo = err.message;
    if (status === 403) {
      motivo = `a planilha existe, mas a service account nao tem acesso — compartilhe com ${email} como Editor`;
    } else if (status === 404) {
      motivo = 'GOOGLE_SHEET_ID nao encontrada — confira o trecho do meio da URL da planilha';
    }
    return { ok: false, status, motivo, serviceAccount: email };
  }
}

async function getClient() {
  if (!clientPromise) {
    clientPromise = (async () => {
      const auth = new google.auth.GoogleAuth({ credentials: credentials(), scopes: SCOPES });
      return google.sheets({ version: 'v4', auth: await auth.getClient() });
    })().catch((err) => {
      clientPromise = null;
      throw err;
    });
  }
  return clientPromise;
}

/** Nome da coluna -> campo do caso. Aceita variacoes de acento/caixa do config.json. */
const COLUMN_FIELDS = {
  id: 'id',
  medico: 'medico',
  paciente: 'paciente',
  procedimento: 'procedimento',
  data: 'data',
  hospital: 'hospital',
  convenio: 'convenio',
  status: 'status',
  'valor bruto': 'valorBruto',
  'valor pago': 'valorPago',
  'valor a receber': 'valorReceber',
  glosa: 'glosa',
  'recurso de glosa': 'recursoGlosa',
  'parceiro/equipe': 'parceiro',
  parceiro: 'parceiro',
  observacoes: 'observacoes',
  'primeira leitura': '_firstSeen',
  'ultima atualizacao': '_updatedAt',
  mudancas: '_changes',
};

export function columnLetter(index) {
  let value = index + 1;
  let letters = '';
  while (value > 0) {
    const remainder = (value - 1) % 26;
    letters = String.fromCharCode(65 + remainder) + letters;
    value = Math.floor((value - 1) / 26);
  }
  return letters;
}

export function buildRow(record, columns, { changesText = '', firstSeen = '', updatedAt = '' } = {}) {
  return columns.map((column) => {
    const field = COLUMN_FIELDS[normalize(column)];
    if (field === '_changes') return changesText;
    if (field === '_firstSeen') return firstSeen;
    if (field === '_updatedAt') return updatedAt;
    if (!field) return '';
    const value = record[field];
    return value === null || value === undefined ? '' : value;
  });
}

async function getSpreadsheetMeta() {
  const sheets = await getClient();
  const { data } = await sheets.spreadsheets.get({ spreadsheetId: spreadsheetId() });
  const tabs = new Map();
  for (const sheet of data.sheets || []) {
    tabs.set(sheet.properties.title, sheet.properties.sheetId);
  }
  return { sheets, tabs, title: data.properties?.title || '' };
}

/** Cria as abas que faltam e escreve o cabecalho de cada uma. */
export async function ensureTabs() {
  const cfg = getConfig();
  const { sheets, tabs } = await getSpreadsheetMeta();

  const wanted = [
    { title: cfg.sheets.casesTab, header: cfg.sheets.caseColumns },
    { title: cfg.sheets.salaryTab, header: cfg.sheets.salaryColumns },
    { title: cfg.sheets.historyTab, header: cfg.sheets.historyColumns },
  ];

  const missing = wanted.filter((tab) => !tabs.has(tab.title));
  if (missing.length) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: spreadsheetId(),
      requestBody: {
        requests: missing.map((tab) => ({ addSheet: { properties: { title: tab.title } } })),
      },
    });
  }

  for (const tab of wanted) {
    const range = `${tab.title}!A1:${columnLetter(tab.header.length - 1)}1`;
    const { data } = await sheets.spreadsheets.values.get({ spreadsheetId: spreadsheetId(), range });
    const current = data.values?.[0] || [];
    if (current.join('|') !== tab.header.join('|')) {
      await sheets.spreadsheets.values.update({
        spreadsheetId: spreadsheetId(),
        range,
        valueInputOption: 'RAW',
        requestBody: { values: [tab.header] },
      });
    }
  }

  return true;
}

/** Le a aba de cirurgias e indexa as linhas existentes por ID. */
export async function readCaseRows() {
  const cfg = getConfig();
  const sheets = await getClient();
  const columns = cfg.sheets.caseColumns;
  const range = `${cfg.sheets.casesTab}!A2:${columnLetter(columns.length - 1)}`;

  const { data } = await sheets.spreadsheets.values.get({ spreadsheetId: spreadsheetId(), range });
  const rows = data.values || [];

  const index = new Map();
  rows.forEach((row, offset) => {
    const id = (row[0] || '').trim();
    if (id) index.set(id, { rowNumber: offset + 2, values: row });
  });
  return index;
}

/**
 * Escreve casos novos e atualizados na planilha.
 * Linhas com mudanca recebem ⚠️ na coluna "Mudancas" e destaque amarelo.
 */
export async function upsertCases({ added = [], updated = [] } = {}) {
  const cfg = getConfig();
  const sheets = await getClient();
  const columns = cfg.sheets.caseColumns;
  const stamp = nowStamp(cfg.timezone);

  await ensureTabs();
  const index = await readCaseRows();

  const updates = [];
  const appends = [];
  const highlightRowNumbers = [];

  for (const record of added) {
    const row = buildRow(record, columns, { firstSeen: stamp, updatedAt: stamp, changesText: '🆕 caso novo' });
    const existing = index.get(record.id);
    if (existing) {
      updates.push({ rowNumber: existing.rowNumber, row });
      highlightRowNumbers.push(existing.rowNumber);
    } else {
      appends.push(row);
    }
  }

  for (const record of updated) {
    const changesText = `⚠️ ${describeChanges(record.changes || [])}`;
    const existing = index.get(record.id);
    const firstSeen = existing ? existing.values[columns.findIndex((c) => normalize(c) === 'primeira leitura')] || stamp : stamp;
    const row = buildRow(record, columns, { firstSeen, updatedAt: stamp, changesText });

    if (existing) {
      updates.push({ rowNumber: existing.rowNumber, row });
      highlightRowNumbers.push(existing.rowNumber);
    } else {
      appends.push(row);
    }
  }

  const lastColumn = columnLetter(columns.length - 1);

  if (updates.length) {
    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: spreadsheetId(),
      requestBody: {
        valueInputOption: 'USER_ENTERED',
        data: updates.map((item) => ({
          range: `${cfg.sheets.casesTab}!A${item.rowNumber}:${lastColumn}${item.rowNumber}`,
          values: [item.row],
        })),
      },
    });
  }

  if (appends.length) {
    await sheets.spreadsheets.values.append({
      spreadsheetId: spreadsheetId(),
      range: `${cfg.sheets.casesTab}!A1`,
      valueInputOption: 'USER_ENTERED',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: appends },
    });
  }

  if (highlightRowNumbers.length) {
    await highlightRows(cfg.sheets.casesTab, highlightRowNumbers, columns.length).catch((err) =>
      console.error('[sheets] destaque falhou (dados gravados normalmente):', err.message),
    );
  }

  return { updated: updates.length, appended: appends.length };
}

/** Pinta de amarelo as linhas que mudaram nesta rodada. */
async function highlightRows(tabTitle, rowNumbers, columnCount) {
  const { sheets, tabs } = await getSpreadsheetMeta();
  const sheetId = tabs.get(tabTitle);
  if (sheetId === undefined) return;

  const requests = rowNumbers.map((rowNumber) => ({
    repeatCell: {
      range: {
        sheetId,
        startRowIndex: rowNumber - 1,
        endRowIndex: rowNumber,
        startColumnIndex: 0,
        endColumnIndex: columnCount,
      },
      cell: { userEnteredFormat: { backgroundColor: { red: 1, green: 0.95, blue: 0.72 } } },
      fields: 'userEnteredFormat.backgroundColor',
    },
  }));

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: spreadsheetId(),
    requestBody: { requests },
  });
}

/** Registra cada mudanca na aba de historico. */
export async function appendHistory(entries = []) {
  if (!entries.length) return 0;
  const cfg = getConfig();
  const sheets = await getClient();
  const stamp = nowStamp(cfg.timezone);

  const values = entries.map((entry) => [
    stamp,
    entry.id || '',
    entry.medico || '',
    entry.paciente || '',
    entry.field || '',
    entry.from === '' ? '(vazio)' : entry.from,
    entry.to === '' ? '(vazio)' : entry.to,
  ]);

  await sheets.spreadsheets.values.append({
    spreadsheetId: spreadsheetId(),
    range: `${cfg.sheets.historyTab}!A1`,
    valueInputOption: 'USER_ENTERED',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values },
  });

  return values.length;
}

/** Reescreve a aba do salario da Sara (uma linha por mes + total). */
export async function writeSalary(summary) {
  const cfg = getConfig();
  const sheets = await getClient();
  const stamp = nowStamp(cfg.timezone);
  const tab = cfg.sheets.salaryTab;

  const rows = summary.months.map((bucket) => [
    bucket.month,
    bucket.count,
    round2(bucket.gross),
    round2(bucket.tax),
    round2(bucket.net),
    round2(bucket.salary),
    stamp,
  ]);

  rows.push([
    'TOTAL',
    summary.totals.count,
    round2(summary.totals.gross),
    round2(summary.totals.tax),
    round2(summary.totals.net),
    round2(summary.totals.salary),
    stamp,
  ]);

  const lastColumn = columnLetter(cfg.sheets.salaryColumns.length - 1);

  await sheets.spreadsheets.values.clear({
    spreadsheetId: spreadsheetId(),
    range: `${tab}!A2:${lastColumn}`,
  });

  await sheets.spreadsheets.values.update({
    spreadsheetId: spreadsheetId(),
    range: `${tab}!A2`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: rows },
  });

  return rows.length;
}

function round2(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}
