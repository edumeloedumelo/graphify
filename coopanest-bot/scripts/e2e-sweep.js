/**
 * Testa a varredura da listagem de guias contra uma réplica da tela do portal:
 * campo de período, dropdown "Selecione o item" com 4 status, tabela paginada
 * e o rodapé "Mostrando 1 a 10 de 36 resultados".
 *
 *   CHROMIUM_PATH=/caminho/para/chrome node scripts/e2e-sweep.js
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const STATUS = ['Aguardando Pagamento', 'Aguardando Envio', 'Em Processamento', 'Cancelada'];
const QUANTIDADE = { 'Aguardando Pagamento': 12, 'Aguardando Envio': 8, 'Em Processamento': 14, Cancelada: 2 };

const PAGINA = `<!doctype html><html><body>
<h2>Controle de Guias - Cooperados</h2>
<input id="periodo" type="text" value="25/01/2025 - 25/07/2026"/>
<div id="filtro">Selecione o item <i>&#9662;</i></div>
<ul id="opcoes" style="display:none"></ul>
<div>Guias por página: <div id="porPagina">10</div></div>
<table><thead><tr><th>CPSA</th><th>Status</th><th>Paciente</th><th>Data Cirurgia</th><th>Valor Faturado</th></tr></thead>
<tbody id="corpo"></tbody></table>
<div id="rodape"></div>
<div id="paginacao"></div>
<script>
const STATUS = ${JSON.stringify(STATUS)};
const QUANTIDADE = ${JSON.stringify(QUANTIDADE)};
const linhas = [];
let id = 2026240000;
for (const status of STATUS) {
  for (let i = 0; i < QUANTIDADE[status]; i += 1) {
    id += 1;
    linhas.push({
      cpsa: String(id),
      status,
      paciente: 'PACIENTE ' + status.split(' ')[0].toUpperCase() + ' ' + (i + 1),
      data: '1' + ((i % 9) + 1) + '/07/2026',
      valor: 'R$ ' + (500 + i * 7) + ',00',
    });
  }
}
let filtro = '';
let pagina = 1;
const porPagina = 10;

function render() {
  const visiveis = filtro ? linhas.filter((l) => l.status === filtro) : linhas;
  const total = visiveis.length;
  const paginas = Math.max(1, Math.ceil(total / porPagina));
  if (pagina > paginas) pagina = paginas;
  const inicio = (pagina - 1) * porPagina;
  const fatia = visiveis.slice(inicio, inicio + porPagina);

  document.getElementById('corpo').innerHTML = fatia
    .map((l) => '<tr><td>' + l.cpsa + '</td><td>' + l.status + '</td><td>' + l.paciente + '</td><td>' + l.data + '</td><td>' + l.valor + '</td></tr>')
    .join('');
  document.getElementById('rodape').innerHTML =
    '<span>Mostrando</span> <b>' + (total ? inicio + 1 : 0) + '</b> <span>a</span> <b>' +
    Math.min(inicio + porPagina, total) + '</b> <span>de</span> <b>' + total + '</b> <span>resultados</span>';
  document.getElementById('paginacao').innerHTML =
    Array.from({ length: paginas }, (_, i) => '<button class="pg">' + (i + 1) + '</button>').join('');
  for (const botao of document.querySelectorAll('.pg')) {
    botao.onclick = () => { pagina = Number(botao.innerText); render(); };
  }
}

document.getElementById('filtro').onclick = () => {
  const lista = document.getElementById('opcoes');
  const aberto = lista.style.display !== 'none';
  lista.style.display = aberto ? 'none' : 'block';
  lista.innerHTML = aberto ? '' : STATUS.map((s) => '<li class="opt">' + s + '</li>').join('');
  for (const item of document.querySelectorAll('.opt')) {
    item.onclick = (evento) => {
      evento.stopPropagation();
      filtro = item.innerText;
      pagina = 1;
      lista.style.display = 'none';
      lista.innerHTML = '';
      render();
    };
  }
};
render();
</script></body></html>`;

const servidor = http.createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(PAGINA);
});
await new Promise((resolve) => servidor.listen(0, '127.0.0.1', resolve));
const porta = servidor.address().port;

process.env.STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'coopanest-sweep-'));

const { chromium } = await import('playwright');
const { sweepListing, periodoDesejado, lerContagem, pareceListagem } = await import('../src/sweep.js');
const { getConfig } = await import('../src/config.js');

const failures = [];
function check(nome, fn) {
  try {
    fn();
    console.log(`  ok  ${nome}`);
  } catch (err) {
    failures.push(nome);
    console.error(`  FAIL ${nome}: ${err.message}`);
  }
}

console.log('\nvarredura da listagem de guias\n');

check('lerContagem entende o rodape do portal', () => {
  // no portal o texto vem quebrado entre <span> e <b>; a leitura e feita no
  // texto corrido da pagina justamente por isso
  assert.deepEqual(lerContagem('Mostrando 1 a 10 de 36 resultados'), {
    total: 36,
    porPagina: 10,
    paginas: 4,
    confiavel: true,
  });
  assert.deepEqual(lerContagem('Mostrando 1 a 10 de 36 resultados'), {
    total: 36,
    porPagina: 10,
    paginas: 4,
    confiavel: true,
  });
  // numa pagina final o rodape nao permite deduzir o tamanho da pagina
  assert.equal(lerContagem('Mostrando 31 a 36 de 36 resultados').confiavel, false);
  assert.equal(lerContagem('sem numeros'), null);
});

check('periodoDesejado cobre os ultimos 2 anos', () => {
  const texto = periodoDesejado(2, new Date(2026, 6, 25));
  assert.equal(texto, '25/07/2024 - 25/07/2026');
});

const browser = await chromium.launch({
  headless: true,
  args: ['--no-sandbox'],
  ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
});
const page = await browser.newPage();
await page.goto(`http://127.0.0.1:${porta}/`, { waitUntil: 'domcontentloaded' });

const cfg = { ...getConfig(), sweep: { ...getConfig().sweep, esperaMs: 150 } };

check('reconhece a tela como listagem', async () => {
  assert.ok(await pareceListagem(page, cfg));
});

const { paginas, avisos } = await sweepListing(page, { cfg, log: () => {} });
const texto = paginas.map((p) => p.content).join('\n');
const rotulos = paginas.map((p) => p.url);

check('percorreu as 4 paginas da listagem sem filtro', () => {
  const semFiltro = rotulos.filter((r) => r.startsWith('sem filtro'));
  assert.equal(semFiltro.length, 4, `esperava 4 paginas, veio ${semFiltro.length}: ${semFiltro.join(', ')}`);
});

check('aplicou o periodo de 2 anos', () => {
  assert.deepEqual(avisos, [], `avisos: ${avisos.join('; ')}`);
});

check('varreu cada opcao do filtro, uma por uma', () => {
  for (const status of STATUS) {
    const doStatus = rotulos.filter((r) => r.startsWith(`filtro: ${status}`));
    const esperado = Math.ceil(QUANTIDADE[status] / 10);
    assert.equal(doStatus.length, esperado, `${status}: esperava ${esperado} pagina(s), veio ${doStatus.length}`);
  }
});

check('leu as 36 guias, inclusive as canceladas', () => {
  const primeiraPagina = paginas.find((p) => p.url === 'sem filtro — pagina 1').content;
  assert.match(primeiraPagina, /PACIENTE AGUARDANDO 1/);
  // a ultima guia so aparece na pagina 4
  const ultimaPagina = paginas.find((p) => p.url === 'sem filtro — pagina 4').content;
  assert.match(ultimaPagina, /Cancelada/);
  assert.match(texto, /PACIENTE EM 14/, 'faltou a ultima guia de Em Processamento');
});

const valorPeriodo = await page.locator('#periodo').inputValue();
check('o campo de periodo ficou com os 2 anos', () => {
  assert.equal(valorPeriodo, periodoDesejado(2));
});

console.log(`\n${failures.length === 0 ? 'todos os passos ok' : `${failures.length} falha(s)`}\n`);

await browser.close();
servidor.close();
fs.rmSync(process.env.STATE_DIR, { recursive: true, force: true });
process.exit(failures.length === 0 ? 0 : 1);
