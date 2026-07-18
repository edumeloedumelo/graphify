// sheets.js — Google Sheets API v4: leitura e escrita da planilha financeira.
// Abas: "Registros" (dados brutos), "Resumo_Mensal" (pivô mês × anestesista),
// "MM_YYYY" (detalhe mensal, criada sob demanda).

import { google } from 'googleapis';
import { setLastSync } from './state.js';

const REGISTROS_SHEET = 'Registros';
const RESUMO_SHEET = 'Resumo_Mensal';
const REGISTROS_HEADERS = [
  'Data', 'Anestesista', 'Hospital', 'Procedimento', 'Cirurgião',
  'Valor (R$)', 'Status', 'Registrado_em', 'ID',
];

let sheetsClient = null;

function spreadsheetId() {
  const id = process.env.SPREADSHEET_ID;
  if (!id) throw new Error('SPREADSHEET_ID não configurado');
  return id;
}

async function getClient() {
  if (sheetsClient) return sheetsClient;
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT;
  if (!raw) throw new Error('GOOGLE_SERVICE_ACCOUNT não configurado');
  const credentials = JSON.parse(raw);
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  sheetsClient = google.sheets({ version: 'v4', auth });
  return sheetsClient;
}

async function listSheetTitles(api) {
  const meta = await api.spreadsheets.get({ spreadsheetId: spreadsheetId() });
  return meta.data.sheets.map((s) => s.properties.title);
}

async function ensureSheet(api, title, headers) {
  const titles = await listSheetTitles(api);
  if (titles.includes(title)) return false;
  console.log(`[sheets] criando aba "${title}"`);
  await api.spreadsheets.batchUpdate({
    spreadsheetId: spreadsheetId(),
    requestBody: { requests: [{ addSheet: { properties: { title } } }] },
  });
  if (headers?.length) {
    await api.spreadsheets.values.update({
      spreadsheetId: spreadsheetId(),
      range: `'${title}'!A1`,
      valueInputOption: 'RAW',
      requestBody: { values: [headers] },
    });
  }
  return true;
}

export function formatBRL(value) {
  if (value === null || value === undefined || value === '') return '';
  const n = Number(value);
  if (Number.isNaN(n)) return '';
  return `R$${n.toLocaleString('pt-BR')}`;
}

function monthKeyFromDate(dataBR) {
  // "15/07/2025" -> "07/2025"
  const m = String(dataBR).match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return null;
  return `${m[2].padStart(2, '0')}/${m[3]}`;
}

function dateSortKey(dataBR) {
  const m = String(dataBR).match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return 0;
  return Number(m[3]) * 10000 + Number(m[2]) * 100 + Number(m[1]);
}

// ---- leitura ----

export async function getRegistros() {
  const api = await getClient();
  await ensureSheet(api, REGISTROS_SHEET, REGISTROS_HEADERS);
  const res = await api.spreadsheets.values.get({
    spreadsheetId: spreadsheetId(),
    range: `'${REGISTROS_SHEET}'!A2:I`,
  });
  const rows = res.data.values || [];
  return rows
    .filter((r) => r[0])
    .map((r) => ({
      data: r[0] || '',
      anestesista: r[1] || '',
      hospital: r[2] || '',
      procedimento: r[3] || '',
      cirurgiao: r[4] || '',
      valor: r[5] || '',
      status: r[6] || '',
      registradoEm: r[7] || '',
      id: r[8] || '',
      mes: monthKeyFromDate(r[0]),
    }));
}

export async function getRegistrosDoMes(mesKey) {
  const all = await getRegistros();
  return all.filter((r) => r.mes === mesKey && r.status !== 'cancelado');
}

// ---- escrita ----

export async function appendRegistro(registro) {
  const api = await getClient();
  await ensureSheet(api, REGISTROS_SHEET, REGISTROS_HEADERS);
  const row = [
    registro.data,
    registro.anestesista,
    registro.hospital,
    registro.procedimento,
    registro.cirurgiao,
    registro.valor === null || registro.valor === undefined ? '' : registro.valor,
    registro.status,
    new Date().toISOString(),
    registro.id,
  ];
  await api.spreadsheets.values.append({
    spreadsheetId: spreadsheetId(),
    range: `'${REGISTROS_SHEET}'!A:I`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [row] },
  });
  console.log(`[sheets] registro ${registro.id} inserido na aba Registros`);

  const mesKey = monthKeyFromDate(registro.data);
  if (mesKey) {
    await updateResumoMensal(api);
    await updateMonthlySheet(api, mesKey);
  }
  setLastSync();
}

// Resumo_Mensal: linhas = meses (MM/YYYY), colunas = anestesistas + TOTAL.
// Recalculado do zero a cada registro a partir da aba Registros.
async function updateResumoMensal(api) {
  const registros = (await getRegistros()).filter((r) => r.status !== 'cancelado');
  const anesthetists = [...new Set(registros.map((r) => r.anestesista).filter(Boolean))].sort();
  const months = [...new Set(registros.map((r) => r.mes).filter(Boolean))]
    .sort((a, b) => {
      const [ma, ya] = a.split('/').map(Number);
      const [mb, yb] = b.split('/').map(Number);
      return yb * 100 + mb - (ya * 100 + ma); // mais recente primeiro
    });

  const header = ['Mês', ...anesthetists, 'TOTAL'];
  const rows = months.map((mes) => {
    const doMes = registros.filter((r) => r.mes === mes);
    let total = 0;
    const cells = anesthetists.map((a) => {
      const sum = doMes
        .filter((r) => r.anestesista === a)
        .reduce((acc, r) => acc + (Number(r.valor) || 0), 0);
      total += sum;
      return sum ? formatBRL(sum) : '';
    });
    return [mes, ...cells, formatBRL(total)];
  });

  await ensureSheet(api, RESUMO_SHEET);
  await api.spreadsheets.values.clear({
    spreadsheetId: spreadsheetId(),
    range: `'${RESUMO_SHEET}'!A:Z`,
  });
  await api.spreadsheets.values.update({
    spreadsheetId: spreadsheetId(),
    range: `'${RESUMO_SHEET}'!A1`,
    valueInputOption: 'RAW',
    requestBody: { values: [header, ...rows] },
  });
  console.log('[sheets] Resumo_Mensal atualizado');
}

// Aba mensal "MM_YYYY": todos os procedimentos do mês em ordem cronológica
// + linha TOTAL com o total por anestesista e o total geral.
async function updateMonthlySheet(api, mesKey) {
  const title = mesKey.replace('/', '_'); // "07/2025" -> "07_2025"
  const registros = (await getRegistros())
    .filter((r) => r.mes === mesKey && r.status !== 'cancelado')
    .sort((a, b) => dateSortKey(a.data) - dateSortKey(b.data));

  const header = ['Data', 'Anestesista', 'Hospital', 'Procedimento', 'Cirurgião', 'Valor'];
  const rows = registros.map((r) => [
    r.data, r.anestesista, r.hospital, r.procedimento, r.cirurgiao, formatBRL(r.valor),
  ]);

  const totals = {};
  let geral = 0;
  for (const r of registros) {
    const v = Number(r.valor) || 0;
    totals[r.anestesista] = (totals[r.anestesista] || 0) + v;
    geral += v;
  }
  const totalCells = Object.entries(totals).map(([a, v]) => `${a}: ${formatBRL(v)}`);
  const totalRow = ['TOTAL', ...totalCells, `GERAL: ${formatBRL(geral)}`];

  await ensureSheet(api, title);
  await api.spreadsheets.values.clear({
    spreadsheetId: spreadsheetId(),
    range: `'${title}'!A:Z`,
  });
  await api.spreadsheets.values.update({
    spreadsheetId: spreadsheetId(),
    range: `'${title}'!A1`,
    valueInputOption: 'RAW',
    requestBody: { values: [header, ...rows, totalRow] },
  });
  console.log(`[sheets] aba mensal ${title} atualizada (${registros.length} registros)`);
}
