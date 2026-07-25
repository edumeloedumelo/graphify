/**
 * Teste ponta a ponta do fluxo do grupo: abertura → conteúdo → fechamento → /analisar.
 * Sobe mocks locais do UltraMsg e da Anthropic — nenhuma credencial real é usada.
 *   node scripts/e2e-analisar.js
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const CHAT = '120363000000000001@g.us';
const sent = [];
let anthropicCalls = 0;

// dentro da janela do LOOKBACK_SECONDS, senão o fetcher descarta como antigas
const agora = Math.floor(Date.now() / 1000);
const mensagensDoGrupo = [
  { id: 'm1', body: 'Paciente: Maria Silva', type: 'chat', time: agora - 300, fromMe: false },
  { id: 'm2', body: 'Colecistectomia videolaparoscópica em 12/07/2026', type: 'chat', time: agora - 290, fromMe: false },
  { id: 'm3', body: 'Hospital Copa Star, Unimed, bruto R$ 4.200,00', type: 'chat', time: agora - 280, fromMe: false },
  { id: 'm4', body: 'Equipe DATBABY - Dr. Raphael Datrino', type: 'chat', time: agora - 270, fromMe: false },
  { id: 'm5', body: 'Status: em recurso de glosa', type: 'chat', time: agora - 260, fromMe: false },
  { id: 'm6', body: '--------', type: 'chat', time: agora - 250, fromMe: false },
];

const respostaDaIA = JSON.stringify([
  {
    paciente: 'Maria Silva',
    medico: 'Dr. Eduardo',
    procedimento: 'Colecistectomia videolaparoscópica',
    data: '12/07/2026',
    hospital: 'Hospital Copa Star',
    convenio: 'Unimed',
    status: 'Em recurso de glosa',
    valorBruto: 'R$ 4.200,00',
    valorPago: '',
    valorReceber: 'R$ 4.200,00',
    glosa: '',
    recursoGlosa: 'Em recurso',
    parceiro: 'DATBABY / Dr. Raphael Datrino',
    observacoes: '',
  },
]);

const mock = http.createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => {
    body += chunk;
  });
  req.on('end', () => {
    const url = new URL(req.url, 'http://localhost');

    if (url.pathname.endsWith('/chats/messages')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(mensagensDoGrupo));
      return;
    }

    if (url.pathname.endsWith('/messages/chat')) {
      const params = new URLSearchParams(body);
      sent.push({ to: params.get('to'), body: params.get('body') });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ sent: true, id: `mock-${sent.length}` }));
      return;
    }

    if (url.pathname === '/v1/messages') {
      anthropicCalls += 1;
      assert.equal(req.headers['anthropic-version'], '2023-06-01', 'header anthropic-version ausente');
      assert.ok(req.headers['x-api-key'], 'header x-api-key ausente');
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          content: [{ type: 'text', text: respostaDaIA }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 10, output_tokens: 20 },
        }),
      );
      return;
    }

    res.writeHead(404);
    res.end('{}');
  });
});

await new Promise((resolve) => mock.listen(0, '127.0.0.1', resolve));
const port = mock.address().port;

process.env.STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'coopanest-e2e-'));
process.env.ULTRAMSG_BASE_URL = `http://127.0.0.1:${port}`;
process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${port}`;
process.env.ULTRAMSG_INSTANCE_ID = 'instance123';
process.env.ULTRAMSG_TOKEN = 'token-de-teste';
process.env.ANTHROPIC_API_KEY = 'chave-de-teste';
process.env.CHAT_EDUARDO = CHAT;

const { routeWebhook } = await import('../src/router.js');
const { getLastTime } = await import('../src/state.js');
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

console.log('\ncaso completo: abertura → conteúdo → fechamento → /analisar\n');

const cmdTime = agora - 10;
await routeWebhook({
  event_type: 'message_received',
  data: { from: CHAT, body: '/analisar', type: 'chat', author: '5521999999999@c.us', time: cmdTime },
});

const relatorio = sent.map((message) => message.body).join('\n');

check('o bot avisou que começou e depois mandou o resumo', () => {
  assert.ok(sent.length >= 2, `esperava 2+ mensagens, veio ${sent.length}`);
  assert.match(sent[0].body, /Analisando/);
  assert.match(relatorio, /Resumo do caso/);
});

check('todas as mensagens foram para o grupo certo', () => {
  assert.ok(sent.every((message) => message.to === CHAT));
});

check('a IA foi chamada uma vez para o bloco do caso', () => {
  assert.equal(anthropicCalls, 1);
});

check('o caso virou registro novo com os dados extraídos', () => {
  const snapshot = Object.values(loadSnapshot());
  assert.equal(snapshot.length, 1);
  const item = snapshot[0];
  assert.equal(item.paciente, 'Maria Silva');
  assert.equal(item.data, '12/07/2026');
  assert.equal(item.valorBruto, 4200);
  assert.equal(item.status, 'Em recurso de glosa');
  assert.equal(item.doctorId, 'eduardo', 'o caso deveria ter sido vinculado ao Dr. Eduardo');
});

check('o resumo mostrou o caso como novo', () => {
  assert.match(relatorio, /cirurgia\(s\) nova\(s\)/);
  assert.match(relatorio, /Maria Silva/);
});

check('o caso entra no cálculo do salário da Sara', () => {
  const summary = computeSalary(Object.values(loadSnapshot()));
  assert.equal(summary.totals.count, 1);
  assert.equal(summary.totals.gross, 4200);
  assert.equal(summary.totals.net, 3360); // 4200 - 20%
  assert.equal(summary.totals.salary, 168); // 5% de 3360
});

check('o marcador de tempo avançou (não reanalisa as mesmas mensagens)', () => {
  assert.ok(getLastTime(CHAT) >= cmdTime, `lastTime=${getLastTime(CHAT)} deveria ser >= ${cmdTime}`);
});

// segunda rodada: mesmas mensagens, nada novo desde o marcador
const antes = sent.length;
await routeWebhook({
  event_type: 'message_received',
  data: { from: CHAT, body: '/analisar', type: 'chat', author: '5521999999999@c.us', time: cmdTime + 60 },
});

check('rodar de novo não duplica o caso', () => {
  assert.equal(Object.keys(loadSnapshot()).length, 1);
  const novas = sent.slice(antes).map((message) => message.body).join('\n');
  assert.match(novas, /Nenhuma mensagem nova/);
});

console.log(`\n${failures.length === 0 ? 'todos os passos ok' : `${failures.length} falha(s)`}\n`);

mock.close();
fs.rmSync(process.env.STATE_DIR, { recursive: true, force: true });
process.exit(failures.length === 0 ? 0 : 1);
