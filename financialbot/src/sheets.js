// Google Sheets API v4: aba Registros (dados brutos), Resumo_Mensal e abas
// mensais MM_YYYY criadas dinamicamente. Toda gravação = append em Registros +
// rebuild das abas de resumo daquele mês.
import { google } from 'googleapis';
import crypto from 'crypto';
import { touchLastSync } from './state.js';

const REGISTROS = 'Registros';
const RESUMO = 'Resumo_Mensal';
const REGISTROS_HEADERS = [
  'Data', 'Anestesista', 'Hospital', 'Procedimento', 'Cirurgião',
  'Valor (R$)', 'Status', 'Registrado_em', 'ID',
];

let sheetsApi = null;

function api() {
  if (sheetsApi) return sheetsApi;
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT;
  if (!raw) throw new Error('GOOGLE_SERVICE_ACCOUNT não configurado');
  const creds = JSON.parse(raw);
  const auth = new google.auth.JWT(
    creds.client_email,
    null,
    creds.private_key,
    ['https://www.googleapis.com/auth/spreadsheets'],
  );
  sheetsApi = google.sheets({ version: 'v4', auth });
  return sheetsApi;
}

function spreadsheetId() {
  const id = process.env.SPREADSHEET_ID;
  if (!id) throw new Error('SPREADSHEET_ID não configurado');
  return id;
}

export function monthKey(dateStr) {
  // "15/07/2025" -> "07/2025"
  const m = String(dateStr || '').match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  return m ? `${m[2]}/${m[3]}` : null;
}

export function monthTabName(month) {
  return month.replace('/', '_'); // "07/2025" -> "07_2025"
}

function fmtBRL(n) {
  if (n === null || n === undefined || n === '') return '';
  return `R$${Number(n).toLocaleString('pt-BR')}`;
}

function dateSortKey(d) {
  const m = String(d || '').match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  return m ? `${m[3]}${m[2]}${m[1]}` : '99999999';
}

async function listSheetTitles() {
  const res = await api().spreadsheets.get({
    spreadsheetId: spreadsheetId(),
    fields: 'sheets.properties.title',
  });
  return (res.data.sheets || []).map((s) => s.properties.title);
}

async function ensureSheet(title, headers) {
  const titles = await listSheetTitles();
  if (titles.includes(title)) return false;
  console.log(`[sheets] criando aba "${title}"`);
  await api().spreadsheets.batchUpdate({
    spreadsheetId: spreadsheetId(),
    requestBody: { requests: [{ addSheet: { properties: { title } } }] },
  });
  if (headers) {
    await api().spreadsheets.values.update({
      spreadsheetId: spreadsheetId(),
      range: `'${title}'!A1`,
      valueInputOption: 'RAW',
      requestBody: { values: [headers] },
    });
  }
  return true;
}

// ---------- leitura ----------

export async function getAllRecords() {
  await ensureSheet(REGISTROS, REGISTROS_HEADERS);
  const res = await api().spreadsheets.values.get({
    spreadsheetId: spreadsheetId(),
    range: `'${REGISTROS}'!A2:I`,
  });
  return (res.data.values || [])
    .filter((r) => r[0])
    .map((r) => ({
      data: r[0],
      anestesista: r[1] || '',
      hospital: r[2] || '',
      procedimento: r[3] || '',
      cirurgiao: r[4] || '',
      valor: r[5] !== undefined && r[5] !== '' ? Number(String(r[5]).replace(/[^\d.,-]/g, '').replace(',', '.')) : null,
      status: r[6] || 'realizado',
      registradoEm: r[7] || '',
      id: r[8] || '',
    }));
}

export async function getRecordsForMonth(month) {
  const all = await getAllRecords();
  return all
    .filter((r) => monthKey(r.data) === month)
    .sort((a, b) => dateSortKey(a.data).localeCompare(dateSortKey(b.data)));
}

// ---------- escrita ----------

export async function appendRecord(record, valor) {
  await ensureSheet(REGISTROS, REGISTROS_HEADERS);
  const id = crypto.randomUUID().slice(0, 8);
  const row = [
    record.data,
    record.nome_anestesista,
    record.hospital,
    record.procedimento,
    record.cirurgiao,
    valor === null || valor === undefined ? '' : valor,
    record.status || 'realizado',
    new Date().toISOString(),
    id,
  ];
  await api().spreadsheets.values.append({
    spreadsheetId: spreadsheetId(),
    range: `'${REGISTROS}'!A1`,
    valueInputOption: 'USER_ENTERED',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: [row] },
  });
  console.log(`[sheets] registro ${id} gravado (${record.procedimento} em ${record.data})`);

  const month = monthKey(record.data);
  if (month) {
    await rebuildMonthTab(month);
    await rebuildResumoMensal();
  }
  touchLastSync();
  return id;
}

async function clearAndWrite(title, values) {
  await api().spreadsheets.values.clear({
    spreadsheetId: spreadsheetId(),
    range: `'${title}'!A1:Z10000`,
  });
  await api().spreadsheets.values.update({
    spreadsheetId: spreadsheetId(),
    range: `'${title}'!A1`,
    valueInputOption: 'RAW',
    requestBody: { values },
  });
}

// Aba "MM_YYYY": procedimentos do mês em ordem cronológica + linha TOTAL.
export async function rebuildMonthTab(month) {
  const tab = monthTabName(month);
  await ensureSheet(tab);
  const records = await getRecordsForMonth(month);

  const rows = [['Data', 'Anestesista', 'Hospital', 'Procedimento', 'Cirurgião', 'Valor']];
  for (const r of records) {
    rows.push([r.data.slice(0, 5), r.anestesista, r.hospital, r.procedimento, r.cirurgiao, fmtBRL(r.valor)]);
  }

  const byAnest = {};
  let geral = 0;
  for (const r of records) {
    const v = r.valor || 0;
    byAnest[r.anestesista] = (byAnest[r.anestesista] || 0) + v;
    geral += v;
  }
  const totals = Object.entries(byAnest)
    .sort((a, b) => b[1] - a[1])
    .map(([name, v]) => `${name}: ${fmtBRL(v)}`);
  rows.push([]);
  rows.push(['TOTAL', ...totals, `GERAL: ${fmtBRL(geral)}`]);

  await clearAndWrite(tab, rows);
  console.log(`[sheets] aba ${tab} atualizada (${records.length} registros)`);
}

// Aba "Resumo_Mensal": linhas = meses, colunas dinâmicas = anestesistas + TOTAL.
export async function rebuildResumoMensal() {
  await ensureSheet(RESUMO);
  const all = await getAllRecords();

  const months = {};
  const anestSet = new Set();
  for (const r of all) {
    const month = monthKey(r.data);
    if (!month) continue;
    months[month] = months[month] || {};
    months[month][r.anestesista] = (months[month][r.anestesista] || 0) + (r.valor || 0);
    anestSet.add(r.anestesista);
  }

  const anests = [...anestSet].sort((a, b) => a.localeCompare(b, 'pt-BR'));
  const monthList = Object.keys(months).sort((a, b) => {
    const [ma, ya] = a.split('/');
    const [mb, yb] = b.split('/');
    return `${yb}${mb}`.localeCompare(`${ya}${ma}`); // mais recente primeiro
  });

  const rows = [['Mês', ...anests, 'TOTAL']];
  for (const month of monthList) {
    const perAnest = anests.map((a) => months[month][a] || 0);
    const total = perAnest.reduce((s, v) => s + v, 0);
    rows.push([month, ...perAnest.map(fmtBRL), fmtBRL(total)]);
  }

  await clearAndWrite(RESUMO, rows);
  console.log(`[sheets] ${RESUMO} atualizado (${monthList.length} meses)`);
}
