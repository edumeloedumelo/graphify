/**
 * Teste ponta a ponta da varredura completa do portal.
 *
 * O portal falso tem: menu inicial → listagem paginada (2 páginas) → uma tela de
 * detalhe por cirurgia → páginas sem dado nenhum → e um link de LOGOUT que, se
 * for visitado, derruba a sessão e faz o resto da varredura falhar.
 *
 * Precisa de um Chromium. Se o do Playwright não estiver instalado:
 *   CHROMIUM_PATH=/caminho/para/chrome node scripts/e2e-sync.js
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

// o portal muda o status da Maria entre a 1a e a 3a varredura
let statusMaria = 'Em recurso de glosa';
let pagoMaria = '0,00';

let sessaoDerrubada = false;
const visitadas = [];
const paginasEnviadasParaIA = [];

const cirurgias = {
  1001: {
    paciente: 'Maria Silva',
    procedimento: 'Colecistectomia videolaparoscópica',
    data: '12/07/2026',
    hospital: 'Copa Star',
    convenio: 'Unimed',
    equipe: 'DATBABY - Dr. Raphael Datrino',
    bruto: '4.200,00',
  },
  1002: {
    paciente: 'João Souza',
    procedimento: 'Herniorrafia inguinal',
    data: '13/07/2026',
    hospital: 'Samaritano',
    convenio: 'Bradesco',
    equipe: 'Dr. Thiago Dantas',
    bruto: '3.000,00',
  },
  1003: {
    paciente: 'Ana Pereira',
    procedimento: 'Rinoplastia',
    data: '02/08/2026',
    hospital: 'Copa Star',
    convenio: 'Particular',
    equipe: 'Dra. Fernanda',
    bruto: '2.500,00',
  },
};

function linhaListagem(id) {
  const item = cirurgias[id];
  const status = id === '1001' || id === 1001 ? statusMaria : 'Aguardando faturamento';
  const pago = id === '1001' || id === 1001 ? pagoMaria : '0,00';
  return `<tr>
    <td><a href="/cirurgia/${id}">${id}</a></td>
    <td>${item.paciente}</td><td>${item.procedimento}</td><td>${item.data}</td>
    <td>${item.hospital}</td><td>${item.convenio}</td><td>${status}</td>
    <td>${item.bruto}</td><td>${pago}</td><td>${item.equipe}</td>
  </tr>`;
}

const CABECALHO =
  '<tr><th>Guia</th><th>Paciente</th><th>Procedimento</th><th>Data</th><th>Hospital</th><th>Convênio</th><th>Status</th><th>Valor Bruto</th><th>Valor Pago</th><th>Equipe</th></tr>';

const MENU = `<ul>
  <li><a href="/cirurgias">Minhas cirurgias</a></li>
  <li><a href="/avisos">Avisos da cooperativa</a></li>
  <li><a href="/ajuda">Ajuda</a></li>
  <li><a href="/logout">Sair do sistema</a></li>
</ul>`;

const portal = http.createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => {
    body += chunk;
  });
  req.on('end', () => {
    const url = new URL(req.url, 'http://localhost');
    const autenticado = (req.headers.cookie || '').includes('sessao=ok') && !sessaoDerrubada;
    visitadas.push(url.pathname + url.search);

    const html = (conteudo) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(`<html><body><a href="/logout">Sair</a>${MENU}${conteudo}</body></html>`);
    };

    if (url.pathname === '/logout') {
      sessaoDerrubada = true;
      res.writeHead(302, { location: '/login', 'set-cookie': 'sessao=; Path=/; Max-Age=0' });
      res.end();
      return;
    }

    if (url.pathname === '/login') {
      if (req.method === 'POST') {
        const params = new URLSearchParams(body);
        if (params.get('usuario') !== 'dr.eduardo' || params.get('senha') !== 'segredo123') {
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
          res.end('<html><body>Usuário ou senha inválidos</body></html>');
          return;
        }
        sessaoDerrubada = false;
        res.writeHead(302, { location: '/cirurgias', 'set-cookie': 'sessao=ok; Path=/' });
        res.end();
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(`<html><body><h1>Coopanest Rio</h1>
        <form method="POST" action="/login">
          <input name="usuario" type="text"/><input name="senha" type="password"/>
          <button type="submit">Entrar</button>
        </form></body></html>`);
      return;
    }

    if (!autenticado) {
      res.writeHead(302, { location: '/login' });
      res.end();
      return;
    }

    // listagem paginada: página 1 tem 2 cirurgias, página 2 tem 1
    if (url.pathname === '/cirurgias') {
      const pagina = Number(url.searchParams.get('pagina') || '1');
      const ids = pagina === 1 ? ['1001', '1002'] : ['1003'];
      const proxima =
        pagina === 1
          ? '<div class="pagination"><a class="next" href="/cirurgias?pagina=2">Próxima</a></div>'
          : '<div class="pagination"><span class="next disabled">Próxima</span></div>';
      html(`<h2>Cirurgias</h2><table>${CABECALHO}${ids.map(linhaListagem).join('')}</table>${proxima}`);
      return;
    }

    // tela de detalhe: traz o recurso de glosa, que não aparece na listagem
    const detalhe = url.pathname.match(/^\/cirurgia\/(\d+)$/);
    if (detalhe) {
      const id = detalhe[1];
      const item = cirurgias[id];
      if (!item) {
        res.writeHead(404);
        res.end('nao encontrada');
        return;
      }
      const status = id === '1001' ? statusMaria : 'Aguardando faturamento';
      const recurso = id === '1001' && /recurso/i.test(status) ? 'Em recurso' : 'Sem recurso';
      html(`<h2>Cirurgia ${id}</h2><table>${CABECALHO}${linhaListagem(id)}</table>
        <table><tr><th>Paciente</th><th>Recurso de Glosa</th><th>Observação</th></tr>
        <tr><td>${item.paciente}</td><td>${recurso}</td><td>Guia ${id} - anestesia geral</td></tr></table>`);
      return;
    }

    if (url.pathname === '/avisos') {
      html('<h2>Avisos</h2><p>Assembleia geral marcada para o dia 30. Compareça.</p>');
      return;
    }

    if (url.pathname === '/ajuda') {
      html('<h2>Ajuda</h2><p>Em caso de dúvida, procure a secretaria da cooperativa.</p>');
      return;
    }

    res.writeHead(404);
    res.end('nao encontrado');
  });
});

/** Lê as tabelas serializadas e devolve o JSON que a Anthropic devolveria. */
function fakeExtraction(promptText) {
  const cases = [];
  const recursoPorPaciente = {};

  for (const line of promptText.split('\n')) {
    const cells = line.split('|').map((cell) => cell.trim());
    if (cells.length === 3 && /^(Em recurso|Sem recurso)$/.test(cells[1])) {
      recursoPorPaciente[cells[0]] = { recursoGlosa: cells[1], observacoes: cells[2] };
    }
  }

  for (const line of promptText.split('\n')) {
    const cells = line.split('|').map((cell) => cell.trim());
    if (cells.length < 10) continue;
    if (!/^\d{2}\/\d{2}\/\d{4}$/.test(cells[3])) continue;
    const extra = recursoPorPaciente[cells[1]] || {};
    cases.push({
      paciente: cells[1],
      medico: /Fernanda/i.test(cells[9]) ? 'Dra. Fernanda' : 'Dr. Eduardo',
      procedimento: cells[2],
      data: cells[3],
      hospital: cells[4],
      convenio: cells[5],
      status: cells[6],
      valorBruto: cells[7],
      valorPago: cells[8],
      valorReceber: '',
      glosa: '',
      recursoGlosa: extra.recursoGlosa || '',
      parceiro: cells[9],
      observacoes: extra.observacoes || '',
    });
  }
  return JSON.stringify(cases);
}

const anthropic = http.createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => {
    body += chunk;
  });
  req.on('end', () => {
    const payload = JSON.parse(body);
    const text = String(payload.messages[0].content);
    const label = (text.match(/Conteúdo extraído de: (.+)/) || [])[1] || '?';
    paginasEnviadasParaIA.push(label);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ content: [{ type: 'text', text: fakeExtraction(text) }] }));
  });
});

await new Promise((resolve) => portal.listen(0, '127.0.0.1', resolve));
await new Promise((resolve) => anthropic.listen(0, '127.0.0.1', resolve));
const portalPort = portal.address().port;

process.env.STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'coopanest-sync-'));
process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${anthropic.address().port}`;
process.env.ANTHROPIC_API_KEY = 'chave-de-teste';
process.env.COOPANEST_LOGIN_URL = `http://127.0.0.1:${portalPort}/login`;
process.env.COOPANEST_CASES_URL = '';
process.env.COOPANEST_USER = 'dr.eduardo';
process.env.COOPANEST_PASS = 'segredo123';

const { saveOverride } = await import('../src/config.js');
saveOverride({
  coopanest: { selectors: { username: "input[name='usuario']", password: "input[name='senha']" } },
  crawl: { waitAfterLoadMs: 150 },
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

console.log('\nvarredura 1: portal inteiro, a partir da página pós-login\n');
const primeira = await runSync({ trigger: 'teste' });

check('a varredura passou por todas as páginas, não só a do login', () => {
  assert.equal(primeira.error, undefined, `erro: ${primeira.error}`);
  const caminhos = new Set(visitadas);
  assert.ok(caminhos.has('/cirurgias'), 'não visitou a listagem');
  assert.ok(caminhos.has('/cirurgias?pagina=2'), 'não seguiu a paginação');
  assert.ok(caminhos.has('/cirurgia/1001'), 'não abriu a tela de detalhe da 1001');
  assert.ok(caminhos.has('/cirurgia/1002'), 'não abriu a tela de detalhe da 1002');
  assert.ok(caminhos.has('/cirurgia/1003'), 'não abriu a tela de detalhe da 1003');
  assert.ok(caminhos.has('/avisos'), 'não visitou a página de avisos');
});

check('o crawler NÃO clicou no logout', () => {
  assert.ok(!visitadas.includes('/logout'), 'visitou /logout e derrubaria a sessão');
  assert.equal(sessaoDerrubada, false);
});

check('as 3 cirurgias entraram, sem duplicar listagem x detalhe', () => {
  assert.equal(primeira.added, 3, `esperava 3 casos novos, veio ${primeira.added}`);
  assert.equal(Object.keys(loadSnapshot()).length, 3);
});

check('páginas sem dado não gastaram chamada de IA', () => {
  const enviadas = paginasEnviadasParaIA.join(' ');
  assert.ok(!enviadas.includes('/ajuda'), 'mandou a página de ajuda para a IA');
});

check('o detalhe completou o que faltava na listagem', () => {
  const maria = Object.values(loadSnapshot()).find((item) => item.paciente === 'Maria Silva');
  assert.ok(maria, 'Maria Silva não foi salva');
  assert.equal(maria.recursoGlosa, 'Em recurso', 'o campo só existe na tela de detalhe');
  assert.match(maria.observacoes, /Guia 1001/);
  assert.equal(maria.valorBruto, 4200);
  assert.equal(maria.doctorId, 'eduardo');
});

check('a cirurgia da Dra. Fernanda foi atribuída a ela', () => {
  const ana = Object.values(loadSnapshot()).find((item) => item.paciente === 'Ana Pereira');
  assert.ok(ana, 'Ana Pereira não foi salva (estava só na 2a página da listagem)');
  assert.equal(ana.doctorId, 'fernanda');
});

console.log('\nvarredura 2: nada mudou no portal\n');
const segunda = await runSync({ trigger: 'teste' });

check('sem mudança, nada é reescrito', () => {
  assert.equal(segunda.added, 0);
  assert.equal(segunda.updated, 0);
  assert.equal(segunda.unchanged, 3);
});

console.log('\nvarredura 3: status da Maria vira Pago\n');
statusMaria = 'Pago';
pagoMaria = '4.200,00';
const terceira = await runSync({ trigger: 'teste' });

check('a mudança foi detectada e descrita', () => {
  assert.equal(terceira.updated, 1, `esperava 1 atualização, veio ${terceira.updated}`);
  assert.equal(terceira.added, 0);
  const mudanca = terceira.changes[0];
  assert.equal(mudanca.paciente, 'Maria Silva');
  const texto = mudanca.changes.join(' ');
  assert.match(texto, /status: Em recurso de glosa → Pago/);
  assert.match(texto, /valorPago/);
});

check('o salário da Sara sai das cirurgias dos parceiros', () => {
  const summary = computeSalary(Object.values(loadSnapshot()));
  assert.equal(summary.totals.count, 2, 'só DATBABY/Datrino e Thiago Dantas contam');
  assert.equal(summary.totals.gross, 7200);
  assert.equal(summary.totals.net, 5760); // 7200 - 20%
  assert.equal(summary.totals.salary, 288); // 5% de 5760
});

console.log(`\n${failures.length === 0 ? 'todos os passos ok' : `${failures.length} falha(s)`}\n`);

portal.close();
anthropic.close();
fs.rmSync(process.env.STATE_DIR, { recursive: true, force: true });
process.exit(failures.length === 0 ? 0 : 1);
