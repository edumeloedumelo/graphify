// format.js — formatação de mensagens para WhatsApp.
// Neste fluxo (grupo da secretária) os valores APARECEM nas respostas —
// é a própria secretária quem os informa.

import { computeSaraSalary } from './sara.js';

const MONTH_NAMES = [
  'Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho',
  'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro',
];

const DIVIDER = '━━━━━━━━━━━━━━';

export const STATUS_EMOJI = { pago: '✅', glosado: '✂️', pendente: '⏳' };
export const STATUS_TEXT = { pago: 'Pago 100%', glosado: 'Glosado', pendente: 'Pendente' };

export function formatBRL(value) {
  if (value === null || value === undefined || value === '') return '';
  const n = Number(value);
  if (Number.isNaN(n)) return '';
  const opts = Number.isInteger(n) ? {} : { minimumFractionDigits: 2, maximumFractionDigits: 2 };
  return `R$${n.toLocaleString('pt-BR', opts)}`;
}

export function monthLabel(mesKey) {
  const [m, y] = mesKey.split('/');
  return `${MONTH_NAMES[Number(m) - 1]}/${y}`;
}

function shortDate(dataBR) {
  const m = String(dataBR).match(/^(\d{1,2}\/\d{1,2})/);
  return m ? m[1] : dataBR;
}

function statusLine(r) {
  const emoji = STATUS_EMOJI[r.status] || '';
  const text = STATUS_TEXT[r.status] || r.status;
  if (r.status === 'glosado') {
    return `${emoji} ${text} (recebido ${formatBRL(r.valorPago)}, glosa ${formatBRL(r.glosa)})`;
  }
  return `${emoji} ${text}`;
}

export function formatRegistroConfirmado(r, groupName) {
  const lines = [
    `✅ *Registro salvo*${groupName ? ` — ${groupName}` : ''}`,
    `🧑 Paciente: ${r.paciente}`,
  ];
  if (r.procedimento) lines.push(`🔪 Procedimento: ${r.procedimento}`);
  if (r.cirurgiao) lines.push(`👨‍⚕️ Cirurgião: ${r.cirurgiao}`);
  if (r.clinica) lines.push(`🏥 Clínica: ${r.clinica}`);
  if (r.convenio) lines.push(`💳 Convênio: ${r.convenio}`);
  lines.push(`📅 Data: ${r.data}`);
  lines.push(`💰 Valor: ${formatBRL(r.valor)}`);
  lines.push(`💳 Situação: ${statusLine(r)}`);
  if (r.observacoes) lines.push(`📝 Obs: ${r.observacoes}`);
  if (r.contaSara) lines.push('👩‍💼 _Conta para a comissão da Sara_');
  return lines.join('\n');
}

export function formatPagamentoAtualizado(r) {
  return [
    '🔄 *Pagamento atualizado*',
    `🧑 Paciente: ${r.paciente}`,
    `📅 Atendimento: ${r.data}${r.procedimento ? ` – ${r.procedimento}` : ''}`,
    `💰 Valor: ${formatBRL(r.valor)}`,
    `💳 Situação: ${statusLine(r)}`,
  ].join('\n');
}

export function formatCamposFaltando(missing) {
  const lista = missing.map((f) => `  • ${f}`).join('\n');
  return [
    '⚠️ *Quase lá!* Para registrar, ainda preciso de:',
    lista,
    '',
    '_Responda com a informação que falta._',
  ].join('\n');
}

function totalsBlock(registros) {
  const faturado = registros.reduce((a, r) => a + (r.valor || 0), 0);
  const recebido = registros.reduce((a, r) => a + (r.valorPago || 0), 0);
  const glosas = registros.reduce((a, r) => a + (r.glosa || 0), 0);
  const pendente = registros.reduce((a, r) => a + Math.max((r.valor || 0) - (r.valorPago || 0) - (r.glosa || 0), 0), 0);
  return [
    `💰 Faturado: *${formatBRL(faturado)}*`,
    `✅ Recebido: *${formatBRL(recebido)}*`,
    `✂️ Glosas: *${formatBRL(glosas)}*`,
    `⏳ Pendente: *${formatBRL(pendente)}*`,
  ].join('\n');
}

// Relatório mensal: totais + detalhe por paciente.
export function formatRelatorio(mesKey, registros, groupName) {
  const lines = [
    `🏦 *FINANCIAL BOT CONTROL*${groupName ? ` — ${groupName}` : ''}`,
    DIVIDER,
    `📅 *${monthLabel(mesKey)}* — ${registros.length} registro${registros.length === 1 ? '' : 's'}`,
    DIVIDER,
  ];

  if (!registros.length) {
    lines.push('_Nenhum registro neste mês._');
    return lines.join('\n');
  }

  lines.push(totalsBlock(registros));
  lines.push(DIVIDER);

  const byPatient = new Map();
  for (const r of registros) {
    const key = r.paciente;
    if (!byPatient.has(key)) byPatient.set(key, []);
    byPatient.get(key).push(r);
  }

  for (const [paciente, regs] of [...byPatient.entries()].sort((a, b) => a[0].localeCompare(b[0], 'pt-BR'))) {
    lines.push(`🧑 *${paciente}*`);
    for (const r of regs) {
      lines.push(`  • ${shortDate(r.data)} – ${formatBRL(r.valor)} – ${statusLine(r)}`);
    }
  }

  const sara = computeSaraSalary(registros);
  if (sara.count) {
    lines.push(DIVIDER);
    lines.push(`👩‍💼 *Comissão da Sara:* ${formatBRL(sara.comissao)}`);
    lines.push(`_(${sara.count} cirurgia${sara.count === 1 ? '' : 's'} · 5% do líquido)_`);
  }

  lines.push(DIVIDER);
  lines.push('📋 _Controle individual de cada paciente na planilha_');
  return lines.join('\n');
}

// Detalhe da comissão da Sara.
export function formatSara(mesKey, registros) {
  const s = computeSaraSalary(registros);
  const pct = (x) => `${Math.round(x * 100)}%`;
  const lines = [
    `👩‍💼 *Comissão da Sara — ${monthLabel(mesKey)}*`,
    DIVIDER,
  ];
  if (!s.count) {
    lines.push('_Nenhuma cirurgia autorizada pela Sara neste mês._');
    return lines.join('\n');
  }
  lines.push(`🔪 Cirurgias autorizadas: ${s.count}`);
  lines.push(`💰 Bruto: ${formatBRL(s.bruto)}`);
  lines.push(`➖ Imposto (${pct(s.taxRate)}): ${formatBRL(s.imposto)}`);
  lines.push(`💵 Líquido: ${formatBRL(s.liquido)}`);
  lines.push(DIVIDER);
  lines.push(`🧮 *Comissão (${pct(s.commissionRate)}): ${formatBRL(s.comissao)}*`);
  lines.push('');
  lines.push('_Cirurgias:_');
  for (const r of s.qualifying) {
    lines.push(`  • ${r.data} – ${r.paciente} – ${formatBRL(r.valor)}${r.cirurgiao ? ` (${r.cirurgiao})` : ''}`);
  }
  return lines.join('\n');
}

// Controle de um paciente específico.
export function formatPaciente(nome, registros) {
  const lines = [
    `🧑 *${nome}* — controle do paciente`,
    DIVIDER,
  ];
  if (!registros.length) {
    lines.push('_Nenhum registro encontrado._');
    return lines.join('\n');
  }
  for (const r of registros) {
    const extra = r.procedimento ? ` – ${r.procedimento}` : '';
    lines.push(`  • ${r.data}${extra} – ${formatBRL(r.valor)} – ${statusLine(r)}`);
  }
  lines.push(DIVIDER);
  lines.push(totalsBlock(registros));
  return lines.join('\n');
}

// Registros em aberto (pendentes e glosados).
export function formatPendentes(registros) {
  const abertos = registros.filter((r) => r.status !== 'pago');
  const lines = [
    '⏳ *Registros em aberto*',
    DIVIDER,
  ];
  if (!abertos.length) {
    lines.push('🎉 _Nenhuma pendência! Tudo quitado._');
    return lines.join('\n');
  }
  for (const r of abertos.sort((a, b) => a.paciente.localeCompare(b.paciente, 'pt-BR'))) {
    lines.push(`🧑 ${r.paciente} – ${r.data} – ${formatBRL(r.valor)} – ${statusLine(r)}`);
  }
  lines.push(DIVIDER);
  lines.push(totalsBlock(abertos));
  return lines.join('\n');
}

export function formatAjuda(isAdmin) {
  const lines = [
    '🏦 *FINANCIAL BOT CONTROL — Comandos*',
    DIVIDER,
    '*Consulta*',
    '/relatorio — resumo do mês atual',
    '/mes MM/YYYY — relatório de um mês específico',
    '/paciente [nome] — controle completo de um paciente',
    '/pendentes — registros não quitados (pendentes e glosas)',
    '/sara [MM/YYYY] — comissão da secretária no mês',
    '/status — última sincronização com a planilha',
    '/id — mostra o ID deste grupo (para configuração)',
    '/ajuda — esta lista',
  ];
  if (isAdmin) {
    lines.push('');
    lines.push('*Gestão (admin)*');
    lines.push('/saraconfig — vê a config da comissão da Sara');
    lines.push('/addcirurgiao [nome] — inclui cirurgião na comissão da Sara');
    lines.push('/delcirurgiao [nome] — remove cirurgião');
    lines.push('/addclinica [nome] — inclui clínica na comissão da Sara');
    lines.push('/delclinica [nome] — remove clínica');
    lines.push('/setprompt [texto] — instrução extra para o extrator');
    lines.push('/limparprompt — remove instrução extra');
    lines.push('/resetar — reseta posição de leitura do grupo');
  }
  lines.push(DIVIDER);
  lines.push('_Envie paciente, data, valor e situação do pagamento que eu registro automaticamente._');
  lines.push('_Ex: "Maria Silva – 15/07 – R$3.000 – convênio pagou com glosa de R$400"_');
  return lines.join('\n');
}
