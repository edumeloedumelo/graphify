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

const { toNumber, formatDate, monthKey, formatBRL } = await import('../src/format.js');
const { caseKey, diffSnapshot, diffCase } = await import('../src/diff.js');
const { computeSalary, isSalaryCase } = await import('../src/salary.js');
const { normalizeCase, dedupeCases } = await import('../src/extractor.js');
const { doctorByName, getConfig } = await import('../src/config.js');
const { buildRow, columnLetter } = await import('../src/sheets.js');
const { normalizeUrl, shouldVisit, looksLikeData, contentFingerprint, sameOrigin } = await import(
  '../src/crawler.js'
);

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

console.log('\nextrator');
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

console.log('\nmedicos');
test('medico resolvido pelo nome que vem do portal', () => {
  assert.equal(doctorByName('DRA. FERNANDA LIMA')?.id, 'fernanda');
  assert.equal(doctorByName('Dr. Eduardo Melo')?.id, 'eduardo');
  assert.equal(doctorByName('Dr. Ninguem'), null);
});


console.log('\ncrawler');
test('normalizeUrl tira fragmento e barra final, mas mantem a query', () => {
  assert.equal(normalizeUrl('https://portal.com/cirurgias/#topo'), 'https://portal.com/cirurgias');
  assert.equal(normalizeUrl('https://portal.com/lista?pagina=2'), 'https://portal.com/lista?pagina=2');
  assert.equal(normalizeUrl('nao-e-url'), '');
});

test('sameOrigin separa dominios', () => {
  assert.ok(sameOrigin('https://portal.com/a', 'https://portal.com/b'));
  assert.ok(!sameOrigin('https://portal.com/a', 'https://outro.com/b'));
});

test('shouldVisit nunca entra no logout', () => {
  const opts = {
    origin: 'https://portal.com',
    skipPatterns: getConfig().crawl.skipUrlPatterns,
    visited: new Set(),
  };
  assert.ok(!shouldVisit('https://portal.com/logout', opts), 'logout nao pode entrar na fila');
  assert.ok(!shouldVisit('https://portal.com/sair', opts), 'sair nao pode entrar na fila');
  assert.ok(!shouldVisit('https://portal.com/conta/encerrar', opts));
  assert.ok(!shouldVisit('https://portal.com/relatorio.pdf', opts));
  assert.ok(!shouldVisit('mailto:alguem@portal.com', opts));
  assert.ok(!shouldVisit('javascript:void(0)', opts));
});

test('shouldVisit fica no mesmo dominio e nao repete visita', () => {
  const visited = new Set(['https://portal.com/ja-vi']);
  const opts = { origin: 'https://portal.com', skipPatterns: [], visited };
  assert.ok(shouldVisit('https://portal.com/cirurgias', opts));
  assert.ok(!shouldVisit('https://portal.com/ja-vi', opts));
  assert.ok(!shouldVisit('https://google.com/busca', opts));
  assert.ok(shouldVisit('https://google.com/busca', { ...opts, sameOriginOnly: false }));
});

test('looksLikeData separa pagina de dados de pagina de menu', () => {
  const keywords = getConfig().crawl.dataKeywords;
  const tabela = 'TABELAS:\nPaciente | Procedimento | Valor\nMaria | Colecistectomia | 4.200,00';
  const menu = 'Bem-vindo ao portal. Escolha uma opcao no menu lateral para continuar.';
  assert.ok(looksLikeData(tabela, { keywords }));
  assert.ok(!looksLikeData(menu, { keywords }));
  assert.ok(!looksLikeData('', { keywords }));
});

test('contentFingerprint iguala paginas com o mesmo conteudo', () => {
  assert.equal(contentFingerprint('a  b\n c'), contentFingerprint('a b c'));
  assert.notEqual(contentFingerprint('pagina 1'), contentFingerprint('pagina 2'));
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
