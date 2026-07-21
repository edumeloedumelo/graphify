// sheets.js — Google Sheets API v4: controle financeiro por paciente.
// Cada grupo de WhatsApp aponta para uma planilha (spreadsheetId) — por isso
// o id é passado em cada operação, permitindo planilhas separadas por grupo.
// Abas por planilha: "Registros" (dados brutos), "Resumo_Mensal" (totais por
// mês), "Pacientes" (uma linha por paciente) e uma aba individual por paciente
// com histórico + totais (criadas automaticamente).

import { google } from 'googleapis';
import { setLastSync } from './state.js';
import { formatBRL } from './format.js';

const REGISTROS_SHEET = 'Registros';
const RESUMO_SHEET = 'Resumo_Mensal';
const PACIENTES_SHEET = 'Pacientes';
const REGISTROS_HEADERS = [
  'Data', 'Paciente', 'Procedimento', 'Convênio', 'Valor (R$)',
  'Valor Pago (R$)', 'Glosa (R$)', 'Status', 'Observações', 'Registrado_em', 'ID',
];

const STATUS_LABEL = { pago: 'Pago 100%', glosado: 'Glosado', pendente: 'Pendente' };

let sheetsClient = null;

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

function requireId(ssid) {
  if (!ssid) throw new Error('spreadsheetId ausente (configure SPREADSHEET_ID ou GROUP_n_SHEET)');
  return ssid;
}

async function listSheetTitles(api, ssid) {
  const meta = await api.spreadsheets.get({ spreadsheetId: ssid });
  return meta.data.sheets.map((s) => s.properties.title);
}

async function ensureSheet(api, ssid, title, headers) {
  const titles = await listSheetTitles(api, ssid);
  if (titles.includes(title)) return false;
  console.log(`[sheets] criando aba "${title}"`);
  await api.spreadsheets.batchUpdate({
    spreadsheetId: ssid,
    requestBody: { requests: [{ addSheet: { properties: { title } } }] },
  });
  if (headers?.length) {
    await api.spreadsheets.values.update({
      spreadsheetId: ssid,
      range: `'${title}'!A1`,
      valueInputOption: 'RAW',
      requestBody: { values: [headers] },
    });
  }
  return true;
}

export function normalizeName(s) {
  return String(s).toLowerCase().normalize('NFD').replace(/\p{M}/gu, '').replace(/\s+/g, ' ').trim();
}

// Título de aba válido para o Sheets (sem []:*?/\ e ≤ 80 chars)
function patientSheetTitle(paciente) {
  return String(paciente).replace(/[[\]:*?/\\]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
}

function monthKeyFromDate(dataBR) {
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

export async function getRegistros(ssid) {
  ssid = requireId(ssid);
  const api = await getClient();
  await ensureSheet(api, ssid, REGISTROS_SHEET, REGISTROS_HEADERS);
  const res = await api.spreadsheets.values.get({
    spreadsheetId: ssid,
    range: `'${REGISTROS_SHEET}'!A2:K`,
  });
  const rows = res.data.values || [];
  return rows
    .map((r, i) => ({ r, rowNumber: i + 2 }))
    .filter(({ r }) => r[0] || r[1])
    .map(({ r, rowNumber }) => ({
      rowNumber,
      data: r[0] || '',
      paciente: r[1] || '',
      procedimento: r[2] || '',
      convenio: r[3] || '',
      valor: Number(r[4]) || 0,
      valorPago: Number(r[5]) || 0,
      glosa: Number(r[6]) || 0,
      status: r[7] || 'pendente',
      observacoes: r[8] || '',
      registradoEm: r[9] || '',
      id: r[10] || '',
      mes: monthKeyFromDate(r[0]),
    }));
}

export async function getRegistrosDoMes(ssid, mesKey) {
  const all = await getRegistros(ssid);
  return all.filter((r) => r.mes === mesKey);
}

export async function getRegistrosDoPaciente(ssid, nome) {
  const all = await getRegistros(ssid);
  const alvo = normalizeName(nome);
  return all.filter((r) => normalizeName(r.paciente).includes(alvo));
}

// ---- escrita ----

export async function appendRegistro(ssid, registro) {
  ssid = requireId(ssid);
  const api = await getClient();
  await ensureSheet(api, ssid, REGISTROS_SHEET, REGISTROS_HEADERS);
  const row = [
    registro.data,
    registro.paciente,
    registro.procedimento || '',
    registro.convenio || '',
    registro.valor ?? '',
    registro.valorPago ?? '',
    registro.glosa ?? '',
    registro.status,
    registro.observacoes || '',
    new Date().toISOString(),
    registro.id,
  ];
  await api.spreadsheets.values.append({
    spreadsheetId: ssid,
    range: `'${REGISTROS_SHEET}'!A:K`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [row] },
  });
  console.log(`[sheets] registro ${registro.id} inserido (${registro.paciente})`);

  await rebuildDerivedSheets(api, ssid, registro.paciente);
  setLastSync();
}

// Atualiza o pagamento do registro mais recente ainda não quitado do paciente.
// Retorna o registro atualizado, ou null se nada foi encontrado.
export async function updatePagamento(ssid, paciente, { status, valorPago, glosa, observacoes }) {
  ssid = requireId(ssid);
  const api = await getClient();
  const registros = await getRegistrosDoPaciente(ssid, paciente);
  if (!registros.length) return null;

  // preferimos o registro em aberto mais recente; se todos quitados, o mais recente
  const abertos = registros.filter((r) => r.status !== 'pago');
  const alvo = (abertos.length ? abertos : registros)
    .sort((a, b) => dateSortKey(b.data) - dateSortKey(a.data))[0];

  const novoStatus = status || alvo.status;
  let novoPago = valorPago ?? alvo.valorPago;
  let novaGlosa = glosa ?? alvo.glosa;
  if (novoStatus === 'pago' && valorPago === null) novoPago = alvo.valor;
  if (novoStatus === 'glosado' && alvo.valor) {
    if (valorPago === null && glosa !== null) novoPago = Math.max(alvo.valor - glosa, 0);
    if (glosa === null && valorPago !== null) novaGlosa = Math.max(alvo.valor - valorPago, 0);
  }
  const novasObs = observacoes
    ? (alvo.observacoes ? `${alvo.observacoes} | ${observacoes}` : observacoes)
    : alvo.observacoes;

  await api.spreadsheets.values.update({
    spreadsheetId: ssid,
    range: `'${REGISTROS_SHEET}'!F${alvo.rowNumber}:I${alvo.rowNumber}`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [[novoPago, novaGlosa, novoStatus, novasObs]] },
  });
  console.log(`[sheets] pagamento atualizado: ${alvo.paciente} ${alvo.data} → ${novoStatus}`);

  await rebuildDerivedSheets(api, ssid, alvo.paciente);
  setLastSync();
  return { ...alvo, status: novoStatus, valorPago: novoPago, glosa: novaGlosa };
}

// ---- abas derivadas (recalculadas do zero a partir de Registros) ----

async function rebuildDerivedSheets(api, ssid, pacienteAlterado) {
  const registros = await getRegistros(ssid);
  await updateResumoMensal(api, ssid, registros);
  await updatePacientesOverview(api, ssid, registros);
  if (pacienteAlterado) await updatePatientSheet(api, ssid, registros, pacienteAlterado);
}

function pendenteDe(r) {
  // saldo em aberto: pendente = valor - pago - glosa (glosa é perda reconhecida)
  return Math.max(r.valor - r.valorPago - r.glosa, 0);
}

async function updateResumoMensal(api, ssid, registros) {
  const months = [...new Set(registros.map((r) => r.mes).filter(Boolean))]
    .sort((a, b) => {
      const [ma, ya] = a.split('/').map(Number);
      const [mb, yb] = b.split('/').map(Number);
      return yb * 100 + mb - (ya * 100 + ma);
    });

  const header = ['Mês', 'Registros', 'Faturado', 'Recebido', 'Glosas', 'Pendente'];
  const rows = months.map((mes) => {
    const doMes = registros.filter((r) => r.mes === mes);
    const faturado = doMes.reduce((a, r) => a + r.valor, 0);
    const recebido = doMes.reduce((a, r) => a + r.valorPago, 0);
    const glosas = doMes.reduce((a, r) => a + r.glosa, 0);
    const pendente = doMes.reduce((a, r) => a + pendenteDe(r), 0);
    return [mes, doMes.length, formatBRL(faturado), formatBRL(recebido), formatBRL(glosas), formatBRL(pendente)];
  });

  await ensureSheet(api, ssid, RESUMO_SHEET);
  await api.spreadsheets.values.clear({ spreadsheetId: ssid, range: `'${RESUMO_SHEET}'!A:Z` });
  await api.spreadsheets.values.update({
    spreadsheetId: ssid,
    range: `'${RESUMO_SHEET}'!A1`,
    valueInputOption: 'RAW',
    requestBody: { values: [header, ...rows] },
  });
  console.log('[sheets] Resumo_Mensal atualizado');
}

// Visão geral: uma linha por paciente com os totais.
async function updatePacientesOverview(api, ssid, registros) {
  const byPatient = new Map();
  for (const r of registros) {
    const key = normalizeName(r.paciente);
    if (!byPatient.has(key)) byPatient.set(key, { nome: r.paciente, regs: [] });
    byPatient.get(key).regs.push(r);
  }

  const header = ['Paciente', 'Registros', 'Faturado', 'Recebido', 'Glosas', 'Pendente', 'Último atendimento'];
  const rows = [...byPatient.values()]
    .sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR'))
    .map(({ nome, regs }) => {
      const faturado = regs.reduce((a, r) => a + r.valor, 0);
      const recebido = regs.reduce((a, r) => a + r.valorPago, 0);
      const glosas = regs.reduce((a, r) => a + r.glosa, 0);
      const pendente = regs.reduce((a, r) => a + pendenteDe(r), 0);
      const ultimo = regs.map((r) => r.data).sort((a, b) => dateSortKey(b) - dateSortKey(a))[0] || '';
      return [nome, regs.length, formatBRL(faturado), formatBRL(recebido), formatBRL(glosas), formatBRL(pendente), ultimo];
    });

  await ensureSheet(api, ssid, PACIENTES_SHEET);
  await api.spreadsheets.values.clear({ spreadsheetId: ssid, range: `'${PACIENTES_SHEET}'!A:Z` });
  await api.spreadsheets.values.update({
    spreadsheetId: ssid,
    range: `'${PACIENTES_SHEET}'!A1`,
    valueInputOption: 'RAW',
    requestBody: { values: [header, ...rows] },
  });
  console.log('[sheets] Pacientes (visão geral) atualizado');
}

// Aba individual do paciente: histórico completo + linha de totais.
async function updatePatientSheet(api, ssid, registros, paciente) {
  const key = normalizeName(paciente);
  const doPaciente = registros
    .filter((r) => normalizeName(r.paciente) === key)
    .sort((a, b) => dateSortKey(a.data) - dateSortKey(b.data));
  if (!doPaciente.length) return;

  const displayName = doPaciente[0].paciente;
  const title = patientSheetTitle(displayName);

  const header = ['Data', 'Procedimento', 'Convênio', 'Valor', 'Valor Pago', 'Glosa', 'Status', 'Observações'];
  const rows = doPaciente.map((r) => [
    r.data, r.procedimento, r.convenio, formatBRL(r.valor), formatBRL(r.valorPago),
    formatBRL(r.glosa), STATUS_LABEL[r.status] || r.status, r.observacoes,
  ]);

  const faturado = doPaciente.reduce((a, r) => a + r.valor, 0);
  const recebido = doPaciente.reduce((a, r) => a + r.valorPago, 0);
  const glosas = doPaciente.reduce((a, r) => a + r.glosa, 0);
  const pendente = doPaciente.reduce((a, r) => a + pendenteDe(r), 0);
  const totalRow = [
    'TOTAL', '', '', formatBRL(faturado), formatBRL(recebido), formatBRL(glosas),
    pendente > 0 ? `Pendente: ${formatBRL(pendente)}` : 'Quitado', '',
  ];

  await ensureSheet(api, ssid, title);
  await api.spreadsheets.values.clear({ spreadsheetId: ssid, range: `'${title}'!A:Z` });
  await api.spreadsheets.values.update({
    spreadsheetId: ssid,
    range: `'${title}'!A1`,
    valueInputOption: 'RAW',
    requestBody: { values: [header, ...rows, totalRow] },
  });
  console.log(`[sheets] aba do paciente "${title}" atualizada (${doPaciente.length} registros)`);
}
