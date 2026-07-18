// format.js — formatação de mensagens para WhatsApp.
// REGRA DE OURO: nenhuma função aqui inclui valores monetários.

const MONTH_NAMES = [
  'Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho',
  'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro',
];

const DIVIDER = '━━━━━━━━━━━━━━';

export function monthLabel(mesKey) {
  // "07/2025" -> "Julho/2025"
  const [m, y] = mesKey.split('/');
  return `${MONTH_NAMES[Number(m) - 1]}/${y}`;
}

function doctorEmoji(name) {
  return /^dra\b/i.test(String(name).trim()) ? '👩‍⚕️' : '👨‍⚕️';
}

export function formatRegistroConfirmado(r) {
  return [
    '✅ *Procedimento registrado*',
    `${doctorEmoji(r.anestesista)} Anestesista: ${r.anestesista}`,
    `🏥 Hospital: ${r.hospital}`,
    `🔪 Procedimento: ${r.procedimento}`,
    `${doctorEmoji(r.cirurgiao)} Cirurgião: ${r.cirurgiao}`,
    `📅 Data: ${r.data}`,
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

function shortDate(dataBR) {
  // "15/07/2025" -> "15/07"
  const m = String(dataBR).match(/^(\d{1,2}\/\d{1,2})/);
  return m ? m[1] : dataBR;
}

// Relatório mensal — SOMENTE contagens e datas, sem valores.
export function formatRelatorio(mesKey, registros) {
  const lines = [
    '🏦 *FINANCIAL BOT CONTROL*',
    DIVIDER,
    `📅 *${monthLabel(mesKey)}* — ${registros.length} procedimento${registros.length === 1 ? '' : 's'}`,
    DIVIDER,
  ];

  if (!registros.length) {
    lines.push('_Nenhum procedimento registrado neste mês._');
    return lines.join('\n');
  }

  const byAnesthetist = new Map();
  for (const r of registros) {
    if (!byAnesthetist.has(r.anestesista)) byAnesthetist.set(r.anestesista, []);
    byAnesthetist.get(r.anestesista).push(r);
  }
  const sorted = [...byAnesthetist.entries()].sort((a, b) => b[1].length - a[1].length);

  for (const [anestesista, regs] of sorted) {
    lines.push(`${doctorEmoji(anestesista)} *${anestesista}* — ${regs.length} procedimento${regs.length === 1 ? '' : 's'}`);
    for (const r of regs) {
      lines.push(`  • ${shortDate(r.data)} – ${r.procedimento} – ${r.hospital}`);
    }
    lines.push('');
  }

  lines.push(DIVIDER);
  lines.push(`📊 *${registros.length} procedimento${registros.length === 1 ? '' : 's'} em ${monthLabel(mesKey).toLowerCase()}*`);
  lines.push('📋 _Valores detalhados na planilha (acesso restrito)_');
  return lines.join('\n');
}

export function formatAnestesista(nome, mesKey, registros) {
  const lines = [
    `${doctorEmoji(nome)} *${nome}* — ${monthLabel(mesKey)}`,
    DIVIDER,
  ];
  if (!registros.length) {
    lines.push('_Nenhum procedimento registrado neste mês._');
  } else {
    for (const r of registros) {
      lines.push(`  • ${shortDate(r.data)} – ${r.procedimento} – ${r.hospital} (Cir.: ${r.cirurgiao})`);
    }
    lines.push('');
    lines.push(`📊 Total: *${registros.length} procedimento${registros.length === 1 ? '' : 's'}*`);
  }
  return lines.join('\n');
}

export function formatAjuda(isAdmin) {
  const lines = [
    '🏦 *FINANCIAL BOT CONTROL — Comandos*',
    DIVIDER,
    '*Consulta*',
    '/relatorio — resumo do mês atual',
    '/mes MM/YYYY — relatório de um mês específico',
    '/anestesista [nome] — procedimentos de um anestesista no mês',
    '/status — última sincronização com a planilha',
    '/ajuda — esta lista',
  ];
  if (isAdmin) {
    lines.push('');
    lines.push('*Gestão de valores (admin)*');
    lines.push('/setvalor Procedimento; 2800 — cadastra/atualiza valor');
    lines.push('/delvalor Procedimento — remove valor');
    lines.push('/valores — lista procedimentos e valores');
    lines.push('/setvalorpadrao 1500 — valor padrão (ou "off" p/ desativar)');
    lines.push('');
    lines.push('*Gestão geral (admin)*');
    lines.push('/setprompt [texto] — instrução extra para o extrator');
    lines.push('/limparprompt — remove instrução extra');
    lines.push('/resetar — reseta posição de leitura do grupo');
  }
  lines.push(DIVIDER);
  lines.push('_Mensagens com médico, hospital, procedimento e data são registradas automaticamente._');
  return lines.join('\n');
}
