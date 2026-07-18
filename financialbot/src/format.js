// Formatação de mensagens para WhatsApp. Valores NUNCA aparecem aqui —
// relatórios mostram apenas contagens, datas e locais.

const MONTH_NAMES = {
  '01': 'Janeiro', '02': 'Fevereiro', '03': 'Março', '04': 'Abril',
  '05': 'Maio', '06': 'Junho', '07': 'Julho', '08': 'Agosto',
  '09': 'Setembro', '10': 'Outubro', '11': 'Novembro', '12': 'Dezembro',
};

const LINE = '━━━━━━━━━━━━━━';

export function monthLabel(month) {
  // "07/2025" -> "Julho/2025"
  const [mm, yyyy] = month.split('/');
  return `${MONTH_NAMES[mm] || mm}/${yyyy}`;
}

export function confirmRegistration(record) {
  return [
    '✅ *Procedimento registrado*',
    `👨‍⚕️ Anestesista: ${record.nome_anestesista}`,
    `🏥 Hospital: ${record.hospital}`,
    `🔪 Procedimento: ${record.procedimento}`,
    `👨‍⚕️ Cirurgião: ${record.cirurgiao}`,
    `📅 Data: ${record.data}`,
  ].join('\n');
}

export function askMissingFields(labels) {
  const list = labels.join(', ');
  return `⚠️ Para registrar, preciso de mais informações: *${list}*.\nResponda com o(s) dado(s) que faltam.`;
}

function anestEmoji(name) {
  return /\bdra\.?\b|doutora/i.test(name || '') ? '👩‍⚕️' : '👨‍⚕️';
}

export function monthReport(month, records) {
  const label = monthLabel(month);
  if (!records.length) {
    return `🏦 *FINANCIAL BOT CONTROL*\n${LINE}\n📅 *${label}* — nenhum procedimento registrado.`;
  }

  const byAnest = {};
  for (const r of records) {
    (byAnest[r.anestesista] = byAnest[r.anestesista] || []).push(r);
  }
  const sorted = Object.entries(byAnest).sort((a, b) => b[1].length - a[1].length);

  const lines = [
    '🏦 *FINANCIAL BOT CONTROL*',
    LINE,
    `📅 *${label}* — ${records.length} procedimento${records.length === 1 ? '' : 's'}`,
    LINE,
  ];
  for (const [name, recs] of sorted) {
    lines.push(`${anestEmoji(name)} *${name}* — ${recs.length} procedimento${recs.length === 1 ? '' : 's'}`);
    for (const r of recs) {
      lines.push(`  • ${r.data.slice(0, 5)} – ${r.procedimento} – ${r.hospital}`);
    }
    lines.push('');
  }
  lines.push(LINE);
  lines.push(`📊 *${records.length} procedimento${records.length === 1 ? '' : 's'} em ${label.toLowerCase()}*`);
  lines.push('📋 _Valores detalhados na planilha (acesso restrito)_');
  return lines.join('\n');
}

export function anesthetistReport(name, month, records) {
  const label = monthLabel(month);
  if (!records.length) {
    return `Nenhum procedimento de *${name}* em ${label}.`;
  }
  const lines = [
    `${anestEmoji(records[0].anestesista)} *${records[0].anestesista}* — ${label}`,
    LINE,
  ];
  for (const r of records) {
    lines.push(`• ${r.data.slice(0, 5)} – ${r.procedimento} – ${r.hospital} – Cirurgião: ${r.cirurgiao}`);
  }
  lines.push(LINE);
  lines.push(`📊 ${records.length} procedimento${records.length === 1 ? '' : 's'}`);
  return lines.join('\n');
}

export function helpText(isAdmin) {
  const lines = [
    '🏦 *FINANCIAL BOT CONTROL — Comandos*',
    LINE,
    '*Consulta*',
    '/relatorio — resumo do mês atual',
    '/mes MM/YYYY — relatório de um mês',
    '/anestesista [nome] — procedimentos de um anestesista no mês',
    '/status — última sincronização com a planilha',
    '/ajuda — esta lista',
  ];
  if (isAdmin) {
    lines.push(
      '',
      '*Valores (admin)*',
      '/setvalor Procedimento; 2800 — cadastra/atualiza valor',
      '/delvalor Procedimento — remove valor',
      '/valores — lista procedimentos e valores',
      '/setvalorpadrao 1500 — valor padrão (ou "off" p/ remover)',
      '',
      '*Gestão (admin)*',
      '/setprompt [texto] — instrução extra para o extrator',
      '/limparprompt — remove instrução extra',
      '/resetar — reseta posição de leitura do grupo',
    );
  }
  lines.push('', '💡 Registros são detectados automaticamente — basta enviar a mensagem do procedimento no grupo.');
  return lines.join('\n');
}
