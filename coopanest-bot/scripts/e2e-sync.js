/**
 * Teste ponta a ponta da varredura: login no portal → leitura da tabela →
 * extração → diff → aviso no grupo. Sobe um portal falso, um UltraMsg falso e
 * uma Anthropic falsa. Nenhuma credencial real é usada.
 *
 * Precisa de um Chromium: defina CHROMIUM_PATH se o do Playwright não estiver instalado.
 *   node scripts/e2e-sync.js
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const CHAT = '120363000000000001@g.us';
const sent = [];

// o portal falso muda o status da Maria entre a 1a e a 2a varredura
let statusMaria = 'Em recurso de glosa';
let pagoMaria = '0,00';

const portal = http.createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => {
    body += chunk;
  });
  req.on('end', () => {
    const url = new URL(req.url, 'http://localhost');

    if (url.pathname === '/login' && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(`<html><body><h1>Coopanest Rio</h1>
        <form method="POST" action="/login">
          <input name="usuario" type="text"/>
          <input name="senha" type="password"/>
          <button type="submit">Entrar</button>
        </form></body></html>`);
      return;
    }

    if (url.pathname === '/login' && req.method === 'POST') {
      const params = new URLSearchParams(body);
      if (params.get('usuario') !== 'dr.eduardo' || params.get('senha') !== 'segredo123') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end('<html><body>Usuário ou senha inválidos</body></html>');
        return;
      }
      res.writeHead(302, { location: '/cirurgias', 'set-cookie': 'sessao=ok; Path=/' });
      res.end();
      return;
    }

    if (url.pathname === '/cirurgias') {
      if (!(req.headers.cookie || '').includes('sessao=ok')) {
        res.writeHead(302, { location: '/login' });
        res.end();
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(`<html><body>
        <a href="/logout">Sair</a>
        <table>
          <tr><th>Paciente</th><th>Procedimento</th><th>Data</th><th>Hospital</th><th>Convênio</th><th>Status</th><th>Bruto</th><th>Pago</th><th>Equipe</th></tr>
          <tr><td>Maria Silva</td><td>Colecistectomia</td><td>12/07/2026</td><td>Copa Star</td><td>Unimed</td><td>${statusMaria}</td><td>4.200,00</td><td>${pagoMaria}</td><td>DATBABY - Dr. Raphael Datrino</td></tr>
          <tr><td>João Souza</td><td>Herniorrafia</td><td>13/07/2026</td><td>Samaritano</td><td>Bradesco</td><td>Aguardando faturamento</td><td>3.000,00</td><td>0,00</td><td>Dr. Thiago Dantas</td></tr>
        </table></body></html>`);
      return;
    }

    res.writeHead(404);
    res.end('nao encontrado');
  });
});

/** Lê a tabela do HTML serializado e devolve o JSON que a Anthropic devolveria. */
function fakeExtraction(promptText) {
  const cases = [];
  for (const line of promptText.split('\n')) {
    const cells = line.split('|').map((cell) => cell.trim());
    if (cells.length < 9 || cells[0] === 'Paciente') continue;
    if (!/^\d{2}\/\d{2}\/\d{4}$/.test(cells[2])) continue;
    cases.push({
      paciente: cells[0],
      medico: 'Dr. Eduardo',
      procedimento: cells[1],
      data: cells[2],
      hospital: cells[3],
      convenio: cells[4],
      status: cells[5],
      valorBruto: cells[6],
      valorPago: cells[7],
      valorReceber: '',
      glosa: '',
      recursoGlosa: /recurso/i.test(cells[5]) ? 'Em recurso' : '',
      parceiro: cells[8],
      observacoes: '',
    });
  }
  return JSON.stringify(cases);
}

const apis = http.createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => {
    body += chunk;
  });
  req.on('end', () => {
    const url = new URL(req.url, 'http://localhost');

    if (url.pathname.endsWith('/messages/chat')) {
      const params = new URLSearchParams(body);
      sent.push({ to: params.get('to'), body: params.get('body') });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"sent":true}');
      return;
    }

    if (url.pathname === '/v1/messages') {
      const payload = JSON.parse(body);
      const text = payload.messages[0].content;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ content: [{ type: 'text', text: fakeExtraction(String(text)) }] }));
      return;
    }

    res.writeHead(404);
    res.end('{}');
  });
});

await new Promise((resolve) => portal.listen(0, '127.0.0.1', resolve));
await new Promise((resolve) => apis.listen(0, '127.0.0.1', resolve));
const portalPort = portal.address().port;
const apiPort = apis.address().port;

process.env.STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'coopanest-sync-'));
process.env.ULTRAMSG_BASE_URL = `http://127.0.0.1:${apiPort}`;
process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${apiPort}`;
process.env.ULTRAMSG_INSTANCE_ID = 'instance123';
process.env.ULTRAMSG_TOKEN = 'token-de-teste';
process.env.ANTHROPIC_API_KEY = 'chave-de-teste';
process.env.CHAT_EDUARDO = CHAT;
process.env.COOPANEST_LOGIN_URL = `http://127.0.0.1:${portalPort}/login`;
process.env.COOPANEST_CASES_URL = `http://127.0.0.1:${portalPort}/cirurgias`;
process.env.COOPANEST_USER = 'dr.eduardo';
process.env.COOPANEST_PASS = 'segredo123';

const { saveOverride } = await import('../src/config.js');
saveOverride({
  coopanest: { selectors: { username: "input[name='usuario']", password: "input[name='senha']" } },
});

const { runSync } = await import('../src/sync.js');
const { loadSnapshot } = await import('../src/snapshot.js');
const { computeSalary } = await import('../src/salary.js');

const failures = [];
function check(name, fn) {
  try {
    fn();
    console.log(`  ok  ${name}`);
  } catch (err) {
    failures.push(name);
    console.error(`  FAIL ${name}: ${err.message}`);
  }
}

console.log('\nvarredura 1: portal vazio → 2 cirurgias novas\n');
const primeira = await runSync({ trigger: 'teste' });

check('login funcionou e as duas cirurgias foram lidas', () => {
  assert.equal(primeira.error, undefined, `erro: ${primeira.error}`);
  assert.equal(primeira.added, 2, `esperava 2 casos novos, veio ${primeira.added}`);
  assert.equal(primeira.updated, 0);
});

check('as cirurgias foram para o grupo do Dr. Eduardo', () => {
  const paraEduardo = sent.filter((message) => message.to === CHAT);
  assert.ok(paraEduardo.length >= 1, 'nenhuma mensagem enviada ao grupo');
  const texto = paraEduardo.map((message) => message.body).join('\n');
  assert.match(texto, /Maria Silva/);
  assert.match(texto, /João Souza/);
});

check('os dados vieram completos do portal', () => {
  const maria = Object.values(loadSnapshot()).find((item) => item.paciente === 'Maria Silva');
  assert.ok(maria, 'Maria Silva não foi salva');
  assert.equal(maria.status, 'Em recurso de glosa');
  assert.equal(maria.valorBruto, 4200);
  assert.equal(maria.hospital, 'Copa Star');
  assert.equal(maria.doctorId, 'eduardo');
});

console.log('\nvarredura 2: nada mudou no portal\n');
const antesDaSegunda = sent.length;
const segunda = await runSync({ trigger: 'teste' });

check('sem mudanças, nada é reescrito nem reenviado', () => {
  assert.equal(segunda.added, 0);
  assert.equal(segunda.updated, 0);
  assert.equal(segunda.unchanged, 2);
  assert.equal(sent.length, antesDaSegunda, 'não deveria ter mandado mensagem sem mudança');
});

console.log('\nvarredura 3: status da Maria muda para Pago\n');
statusMaria = 'Pago';
pagoMaria = '4.200,00';
const terceira = await runSync({ trigger: 'teste' });

check('a mudança de status foi detectada', () => {
  assert.equal(terceira.updated, 1, `esperava 1 atualização, veio ${terceira.updated}`);
  assert.equal(terceira.added, 0);
});

check('o grupo recebeu o aviso com ⚠️ e o antes → depois', () => {
  const texto = sent.slice(antesDaSegunda).map((message) => message.body).join('\n');
  assert.match(texto, /⚠️/);
  assert.match(texto, /Maria Silva/);
  assert.match(texto, /Em recurso de glosa/);
  assert.match(texto, /Pago/);
});

check('o salário da Sara considera as duas cirurgias dos parceiros', () => {
  const summary = computeSalary(Object.values(loadSnapshot()));
  assert.equal(summary.totals.count, 2); // DATBABY/Datrino + Thiago Dantas
  assert.equal(summary.totals.gross, 7200);
  assert.equal(summary.totals.net, 5760);
  assert.equal(summary.totals.salary, 288); // 5% de 5760
});

console.log(`\n${failures.length === 0 ? 'todos os passos ok' : `${failures.length} falha(s)`}\n`);

portal.close();
apis.close();
fs.rmSync(process.env.STATE_DIR, { recursive: true, force: true });
process.exit(failures.length === 0 ? 0 : 1);
