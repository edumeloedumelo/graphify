/**
 * Teste offline da lógica pura: parser, formatação, diff, salário e webhook.
 * Não chama a Anthropic, o UltraMsg, o Google nem o portal.
 *   node scripts/selftest.js
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'coopanest-test-'));
process.env.CHAT_EDUARDO = '120363000000000001@g.us';
process.env.CHAT_FERNANDA = '120363000000000002@g.us';

const { splitMessage, sniffMime } = await import('../src/ultramsg.js');
const { toWhatsApp, toNumber, formatDate, monthKey, formatBRL } = await import('../src/format.js');
const { splitIntoCases, isBotMessage, isCaseOpener, isSeparator, pendingCases } = await import('../src/parser.js');
const { caseKey, diffSnapshot, diffCase } = await import('../src/diff.js');
const { computeSalary, isSalaryCase } = await import('../src/salary.js');
const { normalizeCase, dedupeCases } = await import('../src/triage.js');
const { normalizeWebhook, isChatAllowed } = await import('../src/router.js');
const { parseCommand } = await import('../src/commands.js');
const { doctorByChatId, doctorByName, getConfig } = await import('../src/config.js');
const { buildRow, columnLetter } = await import('../src/sheets.js');

let passed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (err) {
    failures.push({ name, err });
    console.error(`  FAIL ${name}: ${err.message}`);
  }
}

console.log('\nformat');
test('toNumber entende formato brasileiro', () => {
  assert.equal(toNumber('R$ 1.234,56'), 1234.56);
  assert.equal(toNumber('4200.00'), 4200);
  assert.equal(toNumber('1,5'), 1.5);
  assert.equal(toNumber(''), null);
  assert.equal(toNumber('—'), null);
});

test('formatDate e monthKey normalizam datas', () => {
  assert.equal(formatDate('2026-07-12'), '12/07/2026');
  assert.equal(formatDate('5/3/26'), '05/03/2026');
  assert.equal(monthKey('12/07/2026'), '07/2026');
});

test('formatBRL', () => {
  assert.equal(formatBRL(4200), 'R$ 4.200,00');
  assert.equal(formatBRL(''), '');
});

test('toWhatsApp converte markdown', () => {
  const out = toWhatsApp('## Título\n**negrito**\n- item um\n- item dois\n```\ncodigo\n```');
  assert.match(out, /\*Título\*/);
  assert.match(out, /\*negrito\*/);
  assert.match(out, /• item um/);
  assert.ok(!out.includes('```'));
  assert.ok(!out.includes('##'));
});

console.log('\nultramsg');
test('splitMessage respeita o limite de 4000', () => {
  const linha = 'x'.repeat(300);
  const texto = Array.from({ length: 40 }, () => linha).join('\n');
  const chunks = splitMessage(texto);
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every((chunk) => chunk.length <= 4000));
  assert.equal(chunks.join('\n'), texto);
});

test('splitMessage quebra linha maior que o limite', () => {
  const chunks = splitMessage('y'.repeat(9000));
  assert.equal(chunks.length, 3);
});

test('sniffMime reconhece magic bytes', () => {
  assert.equal(sniffMime(Buffer.from('%PDF-1.7 xxxxxxx')), 'application/pdf');
  assert.equal(sniffMime(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0])), 'image/jpeg');
  assert.equal(
    sniffMime(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])),
    'image/png',
  );
  assert.equal(sniffMime(Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP')])), 'image/webp');
  assert.equal(sniffMime(Buffer.from('<!doctype html><body>')), null);
});

console.log('\nparser');
test('isSeparator e isCaseOpener usam regex', () => {
  assert.ok(isSeparator('-----'));
  assert.ok(isSeparator('= = = ='));
  assert.ok(!isSeparator('--x--'));
  assert.ok(isCaseOpener('Paciente: Maria Silva'));
  assert.ok(isCaseOpener('*CASO NOVO*'));
  assert.ok(isCaseOpener('1) Joao'));
  assert.ok(!isCaseOpener('bom dia pessoal'));
});

test('isBotMessage cobre status, erro e laudo', () => {
  assert.ok(isBotMessage({ body: '⏳ Analisando as mensagens novas do grupo...' }));
  assert.ok(isBotMessage({ body: '❌ Erro ao analisar: timeout' }));
  assert.ok(isBotMessage({ body: '📋 *Resumo do caso* (2 blocos)' }));
  assert.ok(isBotMessage({ body: 'qualquer coisa', fromMe: true }));
  assert.ok(!isBotMessage({ body: 'Paciente: Maria' }));
});

test('splitIntoCases separa por abridor e separador', () => {
  const blocks = splitIntoCases([
    { body: 'Paciente: Maria Silva' },
    { body: 'Colecistectomia 12/07/2026' },
    { body: '-----' },
    { body: 'Paciente: Joao Souza' },
    { body: 'Hernia 13/07/2026' },
  ]);
  assert.equal(blocks.length, 2);
  assert.match(blocks[0].text, /Maria Silva/);
  assert.match(blocks[1].text, /Joao Souza/);
});

test('analise bem sucedida marca os blocos anteriores', () => {
  const blocks = splitIntoCases([
    { body: 'Paciente: Maria Silva' },
    { body: '📋 *Resumo do caso* pronto' },
    { body: 'Paciente: Joao Souza' },
  ]);
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0]._alreadyAnalyzed, true);
  assert.equal(blocks[1]._alreadyAnalyzed, false);
  assert.equal(pendingCases([
    { body: 'Paciente: Maria Silva' },
    { body: '📋 *Resumo do caso* pronto' },
    { body: 'Paciente: Joao Souza' },
  ]).length, 1);
});

test('conteudo novo depois da analise reabre o bloco', () => {
  const blocks = splitIntoCases([
    { body: 'Paciente: Maria Silva' },
    { body: '📋 *Resumo do caso* pronto' },
    { body: 'valor corrigido para 5000' },
  ]);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0]._alreadyAnalyzed, false);
});

test('conteudo solto antes do abridor entra no caso', () => {
  const blocks = splitIntoCases([{ body: 'guia 8899' }, { body: 'Paciente: Ana' }]);
  assert.equal(blocks.length, 1);
  assert.match(blocks[0].text, /guia 8899/);
  assert.match(blocks[0].text, /Ana/);
});

console.log('\ndiff');
test('caseKey e estavel e ignora acento/caixa', () => {
  const a = caseKey({ paciente: 'Maria Silva', data: '12/07/2026', procedimento: 'Colecistectomia' });
  const b = caseKey({ paciente: 'MARIA SÍLVA', data: '12/07/2026', procedimento: 'colecistectomia' });
  assert.equal(a, b);
});

test('diffCase ignora campo que sumiu na leitura nova', () => {
  const changes = diffCase({ status: 'Pago', valorPago: 100 }, { status: 'Pago', valorPago: '' }, [
    'status',
    'valorPago',
  ]);
  assert.equal(changes.length, 0);
});

test('diffCase detecta mudanca de status', () => {
  const changes = diffCase({ status: 'Em recurso de glosa' }, { status: 'Pago' }, ['status']);
  assert.equal(changes.length, 1);
  assert.equal(changes[0].from, 'Em recurso de glosa');
  assert.equal(changes[0].to, 'Pago');
});

test('diffSnapshot classifica novo, atualizado e igual', () => {
  const antigo = {
    paciente: 'Maria Silva',
    data: '12/07/2026',
    procedimento: 'Colecistectomia',
    status: 'Em recurso de glosa',
    valorPago: 0,
  };
  const previous = { [caseKey(antigo)]: antigo };

  const { added, updated, unchanged, merged } = diffSnapshot(previous, [
    { ...antigo, status: 'Pago', valorPago: 4200 },
    { paciente: 'Joao Souza', data: '13/07/2026', procedimento: 'Hernia', status: 'Aguardando' },
  ]);

  assert.equal(added.length, 1);
  assert.equal(updated.length, 1);
  assert.equal(unchanged.length, 0);
  assert.equal(updated[0].changes.length, 2);
  assert.equal(Object.keys(merged).length, 2);

  const semMudanca = diffSnapshot(merged, [{ ...antigo, status: 'Pago', valorPago: 4200 }]);
  assert.equal(semMudanca.updated.length, 0);
  assert.equal(semMudanca.unchanged.length, 1);
});

console.log('\nsalario');
test('isSalaryCase reconhece os parceiros', () => {
  assert.ok(isSalaryCase({ parceiro: 'DATBABY' }));
  assert.ok(isSalaryCase({ observacoes: 'equipe do Dr. Raphael Datrino' }));
  assert.ok(isSalaryCase({ parceiro: 'Dr Thiago Dantas' }));
  assert.ok(!isSalaryCase({ parceiro: 'Dr. Carlos Andrade', medico: 'Dr. Eduardo' }));
});

test('computeSalary faz 5% do liquido apos 20% de imposto', () => {
  const summary = computeSalary([
    { paciente: 'A', data: '10/07/2026', parceiro: 'DATBABY', valorBruto: 10000 },
    { paciente: 'B', data: '20/07/2026', parceiro: 'Dr. Thiago Dantas', valorBruto: 5000 },
    { paciente: 'C', data: '20/08/2026', parceiro: 'Dr. Raphael Datrino', valorBruto: 2000 },
    { paciente: 'D', data: '21/08/2026', parceiro: 'Dr. Outro', valorBruto: 9999 },
  ]);

  assert.equal(summary.months.length, 2);
  const julho = summary.months.find((month) => month.month === '07/2026');
  assert.equal(julho.count, 2);
  assert.equal(julho.gross, 15000);
  assert.equal(julho.net, 12000);
  assert.equal(julho.salary, 600); // 15000 - 20% = 12000; 5% = 600
  assert.equal(summary.totals.salary, 680); // + 2000*0.8*0.05 = 80
});

console.log('\ntriage');
test('normalizeCase limpa valores e datas', () => {
  const item = normalizeCase({
    paciente: ' Maria Silva ',
    procedimento: 'Colecistectomia',
    data: '2026-07-12',
    valorBruto: 'R$ 4.200,00',
    glosa: '',
  });
  assert.equal(item.paciente, 'Maria Silva');
  assert.equal(item.data, '12/07/2026');
  assert.equal(item.valorBruto, 4200);
  assert.equal(item.glosa, '');
});

test('normalizeCase descarta objeto sem paciente e sem procedimento', () => {
  assert.equal(normalizeCase({ status: 'Pago' }), null);
});

test('dedupeCases mantem o registro mais completo', () => {
  const list = dedupeCases([
    { paciente: 'Maria', data: '12/07/2026', procedimento: 'Colecistectomia', status: '' },
    { paciente: 'Maria', data: '12/07/2026', procedimento: 'Colecistectomia', status: 'Pago', valorBruto: 100 },
  ]);
  assert.equal(list.length, 1);
  assert.equal(list[0].status, 'Pago');
});

console.log('\nrouter e config');
test('normalizeWebhook entende texto e midia', () => {
  const texto = normalizeWebhook({
    event_type: 'message_received',
    data: { from: '123@g.us', body: '/sync', type: 'chat', author: '5521999@c.us', time: 1750000000 },
  });
  assert.equal(texto.chatId, '123@g.us');
  assert.equal(texto.body, '/sync');
  assert.equal(texto.timestamp, 1750000000);

  const midia = normalizeWebhook({
    data: {
      from: '123@g.us',
      type: 'document',
      body: 'https://media.ultramsg.com/arquivo.pdf',
      caption: 'guia 8899',
      filename: 'guia.pdf',
    },
  });
  assert.equal(midia.mediaUrl, 'https://media.ultramsg.com/arquivo.pdf');
  assert.equal(midia.body, 'guia 8899');
});

test('parseCommand aceita / e !', () => {
  assert.deepEqual(parseCommand('/sync'), { name: 'sync', args: '' });
  assert.deepEqual(parseCommand('!analisar agora'), { name: 'analisar', args: 'agora' });
  assert.equal(parseCommand('bom dia'), null);
});

test('isChatAllowed respeita ALLOWED_CHATS', () => {
  delete process.env.ALLOWED_CHATS;
  assert.ok(isChatAllowed('qualquer@g.us'));
  process.env.ALLOWED_CHATS = '120363000000000001@g.us';
  assert.ok(isChatAllowed('120363000000000001@g.us'));
  assert.ok(!isChatAllowed('outro@g.us'));
  delete process.env.ALLOWED_CHATS;
});

test('medico resolvido por chatId e por nome', () => {
  assert.equal(doctorByChatId('120363000000000001@g.us')?.id, 'eduardo');
  assert.equal(doctorByChatId('120363000000000002@g.us')?.id, 'fernanda');
  assert.equal(doctorByName('DRA. FERNANDA LIMA')?.id, 'fernanda');
  assert.equal(doctorByName('Dr. Eduardo Melo')?.id, 'eduardo');
  assert.equal(doctorByName('Dr. Ninguem'), null);
});

console.log('\nplanilha');
test('columnLetter converte indice em letra', () => {
  assert.equal(columnLetter(0), 'A');
  assert.equal(columnLetter(17), 'R');
  assert.equal(columnLetter(25), 'Z');
  assert.equal(columnLetter(26), 'AA');
});

test('buildRow encaixa cada campo na coluna certa', () => {
  const columns = getConfig().sheets.caseColumns;
  const row = buildRow(
    {
      id: 'abc123',
      medico: 'Dr. Eduardo',
      paciente: 'Maria Silva',
      procedimento: 'Colecistectomia',
      data: '12/07/2026',
      hospital: 'Copa Star',
      convenio: 'Unimed',
      status: 'Pago',
      valorBruto: 4200,
      valorPago: 4200,
      valorReceber: 0,
      glosa: '',
      recursoGlosa: 'Recurso deferido',
      parceiro: 'DATBABY',
      observacoes: '',
    },
    columns,
    { changesText: '⚠️ status: Em recurso de glosa → Pago', firstSeen: '01/07/2026 10:00', updatedAt: '25/07/2026 18:00' },
  );

  assert.equal(row.length, columns.length);
  assert.equal(row[columns.indexOf('ID')], 'abc123');
  assert.equal(row[columns.indexOf('Paciente')], 'Maria Silva');
  assert.equal(row[columns.indexOf('Status')], 'Pago');
  assert.equal(row[columns.indexOf('Valor Bruto')], 4200);
  assert.equal(row[columns.indexOf('Parceiro/Equipe')], 'DATBABY');
  assert.equal(row[columns.indexOf('Primeira Leitura')], '01/07/2026 10:00');
  assert.equal(row[columns.indexOf('Ultima Atualizacao')], '25/07/2026 18:00');
  assert.match(row[columns.indexOf('Mudancas')], /^⚠️ status:/);
});

console.log(`\n${passed} teste(s) ok, ${failures.length} falha(s)\n`);
fs.rmSync(process.env.STATE_DIR, { recursive: true, force: true });
process.exit(failures.length === 0 ? 0 : 1);
