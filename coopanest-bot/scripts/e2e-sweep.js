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
<div>Guias por página: <select id="porPagina"><option>5</option><option selected>10</option><option>20</option><option>30</option><option>50</option></select></div>
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
let porPagina = 10;

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
  const ultima = pagina >= paginas;
  document.getElementById('paginacao').innerHTML =
    Array.from({ length: paginas }, (_, i) =>
      '<button class="pg focus:outline-none disabled:cursor-not-allowed disabled:opacity-75">' + (i + 1) + '</button>'
    ).join('') +
    '<button class="next focus:outline-none disabled:cursor-not-allowed disabled:opacity-75"' +
    (ultima ? ' disabled' : '') + ' aria-label="Next">›</button>';
  for (const botao of document.querySelectorAll('.pg')) {
    botao.onclick = () => { pagina = Number(botao.innerText); render(); };
  }
  const proxima = document.querySelector('.next');
  if (proxima && !ultima) {
    // travado: o clique nao avanca, simulando paginacao quebrada
    proxima.onclick = () => { if (!window.__travado) pagina += 1; render(); };
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
document.getElementById('porPagina').onchange = (evento) => {
  porPagina = Number(evento.target.value);
  pagina = 1;
  render();
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
// async de proposito: uma asserção com await dentro de um check síncrono
// virava promessa solta — o teste imprimia "ok" e a falha aparecia depois,
// fora do relatório
async function check(nome, fn) {
  try {
    await fn();
    console.log(`  ok  ${nome}`);
  } catch (err) {
    failures.push(nome);
    console.error(`  FAIL ${nome}: ${err.message}`);
  }
}

console.log('\nvarredura da listagem de guias\n');

await check('lerContagem entende o rodape do portal', () => {
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

await check('periodoDesejado cobre os ultimos 2 anos', () => {
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

await check('reconhece a tela como listagem', async () => {
  assert.ok(await pareceListagem(page, cfg));
});

const { paginas, avisos } = await sweepListing(page, { cfg, log: () => {} });
const texto = paginas.map((p) => p.content).join('\n');
const rotulos = paginas.map((p) => p.url);

await check('com 50 por pagina, a listagem inteira sai numa leitura', () => {
  // aumentar itens por pagina e a defesa mais forte contra paginacao quebrada:
  // menos cliques, menos chance de travar no meio
  const semFiltro = rotulos.filter((r) => r.startsWith('sem filtro'));
  assert.equal(semFiltro.length, 1, `esperava 1 pagina, veio ${semFiltro.length}: ${semFiltro.join(', ')}`);
});

await check('aplicou o periodo de 2 anos', () => {
  assert.deepEqual(avisos, [], `avisos: ${avisos.join('; ')}`);
});

await check('varreu cada opcao do filtro, uma por uma', () => {
  for (const status of STATUS) {
    const doStatus = rotulos.filter((r) => r.startsWith(`filtro: ${status}`));
    const esperado = Math.ceil(QUANTIDADE[status] / 50);
    assert.equal(doStatus.length, esperado, `${status}: esperava ${esperado} pagina(s), veio ${doStatus.length}`);
  }
});

await check('leu as 36 guias, inclusive as canceladas', () => {
  const semFiltro = paginas.find((p) => p.url === 'sem filtro — pagina 1');
  assert.equal(semFiltro.casos.length, 36, `leu ${semFiltro.casos.length} caso(s)`);
  assert.match(semFiltro.content, /PACIENTE AGUARDANDO 1/);
  assert.match(semFiltro.content, /Cancelada/, 'faltaram as canceladas');
  assert.match(texto, /PACIENTE EM 14/, 'faltou a ultima guia de Em Processamento');

  // nenhuma guia repetida entre as varreduras (sem filtro + por status)
  const guias = paginas.flatMap((p) => (p.casos || []).map((caso) => caso.guia));
  assert.equal(new Set(guias).size, 36, `${guias.length} leituras, ${new Set(guias).size} guias distintas`);
});

const valorPeriodo = await page.locator('#periodo').inputValue();
await check('o campo de periodo ficou com os 2 anos', () => {
  assert.equal(valorPeriodo, periodoDesejado(2));
});

// --- leitura direta da tabela, sem IA ---
const { casosDaPagina, linhasParaCasos } = await import('../src/tabela.js');
const { caseKey } = await import('../src/diff.js');

await page.goto(`http://127.0.0.1:${porta}/`, { waitUntil: 'domcontentloaded' });
const { casos: casosTabela } = await casosDaPagina(page);

await check('le as 10 linhas da tabela direto do DOM', () => {
  assert.equal(casosTabela.length, 10, `leu ${casosTabela.length}`);
});

await check('casa cada coluna pelo cabecalho', () => {
  const primeiro = casosTabela[0];
  assert.match(primeiro.guia, /^\d{10}$/, `guia: ${primeiro.guia}`);
  assert.equal(primeiro.status, 'Aguardando Pagamento');
  assert.equal(primeiro.statusOriginal, 'Aguardando Pagamento');
  assert.match(primeiro.paciente, /^PACIENTE /);
  assert.match(primeiro.data, /^\d{2}\/\d{2}\/\d{4}$/);
  assert.equal(typeof primeiro.valorBruto, 'number');
});

await check('a chave unica usa o CPSA, nao a composicao', () => {
  const chave = caseKey(casosTabela[0]);
  assert.equal(chave, `g${casosTabela[0].guia}`);
  // mesmo caso com nome corrigido continua sendo o mesmo registro
  const corrigido = { ...casosTabela[0], paciente: 'NOME CORRIGIDO', data: '01/01/2020' };
  assert.equal(caseKey(corrigido), chave);
});

await check('tabela com cabecalho irreconhecivel nao vira caso', () => {
  const lixo = { titulos: ['Coluna A', 'Coluna B'], linhas: [{ valores: ['x', 'y'], href: '' }] };
  assert.equal(linhasParaCasos(lixo), null);
});

// --- Tailwind: "disabled:opacity-75" nao e estado desabilitado ---
const { aumentarPorPagina } = await import('../src/sweep.js');

await page.goto(`http://127.0.0.1:${porta}/`, { waitUntil: 'domcontentloaded' });
const escolhido = await aumentarPorPagina(page, 'por página', () => {});

await check('aumenta itens por pagina para o maior valor do select', () => {
  assert.equal(escolhido, 50, `escolheu ${escolhido}`);
});

await check('com 50 por pagina as 36 guias cabem numa pagina so', async () => {
  const linhas = await page.locator('#corpo tr').count();
  assert.equal(linhas, 36, `mostrou ${linhas} linha(s)`);
});

// --- reconciliacao: total informado x coletado ---
const { percorrerPaginas } = await import('../src/sweep.js');
const comum = { rotuloResultados: 'Mostrando', maxPaginas: 40, esperaMs: 120, log: () => {} };

await page.goto(`http://${'127.0.0.1'}:${porta}/`, { waitUntil: 'domcontentloaded' });
const quatroPaginas = await percorrerPaginas(page, { ...comum, label: '4 paginas' });

await check('36 registros em 4 paginas: 10+10+10+6, todas visitadas', () => {
  assert.equal(quatroPaginas.totalInformado, 36);
  assert.equal(quatroPaginas.porPagina, 10);
  assert.equal(quatroPaginas.paginasVisitadas, 4, `visitou ${quatroPaginas.paginasVisitadas}`);
  const porPagina = quatroPaginas.paginas.map((item) => item.casos.length);
  assert.deepEqual(porPagina, [10, 10, 10, 6]);
  assert.equal(quatroPaginas.coletadas, 36);
  assert.equal(quatroPaginas.completou, true, `erros: ${quatroPaginas.erros.join('; ')}`);
});

// o portal informa 36 mas some com uma linha: coletado != informado tem que falhar
await page.goto(`http://${'127.0.0.1'}:${porta}/`, { waitUntil: 'domcontentloaded' });
await page.evaluate(() => {
  window.__sumirUmaLinha = true;
  document.querySelector('#corpo tr:last-child')?.remove();
  const original = document.getElementById('corpo').innerHTML;
  const observador = new MutationObserver(() => {
    const linhas = document.querySelectorAll('#corpo tr');
    if (linhas.length > 1 && window.__sumirUmaLinha) linhas[linhas.length - 1].remove();
  });
  observador.observe(document.getElementById('corpo'), { childList: true });
  return original;
});
const comPerda = await percorrerPaginas(page, { ...comum, label: 'com perda' });

await check('perder uma linha impede a varredura de ser completa', () => {
  assert.equal(comPerda.completou, false);
  assert.ok(comPerda.coletadas < comPerda.totalInformado, 'deveria ter coletado menos que o informado');
  assert.ok(
    comPerda.erros.some((erro) => /informou 36 guias e foram coletadas/.test(erro)),
    `erros: ${comPerda.erros.join('; ')}`,
  );
});

// paginacao travada: assinatura repetida
await page.goto(`http://${'127.0.0.1'}:${porta}/`, { waitUntil: 'domcontentloaded' });
await page.evaluate(() => {
  window.__travado = true;
  for (const botao of document.querySelectorAll('.pg')) botao.onclick = null;
});
const assinaturaRepetida = await percorrerPaginas(page, { ...comum, label: 'assinatura repetida' });

await check('assinatura repetida ou clique sem efeito gera erro', () => {
  assert.equal(assinaturaRepetida.completou, false);
  assert.ok(assinaturaRepetida.erros.length > 0, 'deveria registrar erro');
});

// mais resultados do que cabem na pagina, sem paginacao alcancavel
await page.goto(`http://${'127.0.0.1'}:${porta}/`, { waitUntil: 'domcontentloaded' });
await page.evaluate(() => {
  document.getElementById('paginacao').innerHTML = '';
});
const semPaginacao = await percorrerPaginas(page, { ...comum, label: 'sem paginacao' });

await check('total maior que a pagina sem paginacao e falha, nao sucesso', () => {
  assert.equal(semPaginacao.completou, false, 'nao pode se declarar completa lendo so a primeira pagina');
  assert.ok(
    semPaginacao.erros.some((erro) => /so uma pagina foi lida|foram coletadas/.test(erro)),
    `erros: ${semPaginacao.erros.join('; ')}`,
  );
});

// --- paginacao ---
await page.goto(`http://127.0.0.1:${porta}/`, { waitUntil: 'domcontentloaded' });
const percurso = await percorrerPaginas(page, { ...comum, label: 'percurso' });

await check('percorre ate a ultima pagina e marca como completa', () => {
  assert.equal(percurso.paginasVisitadas, 4, `visitou ${percurso.paginasVisitadas}`);
  assert.equal(percurso.completou, true, `motivo: ${percurso.motivoParada}`);
});

await check('cada pagina tem conteudo distinto', () => {
  const assinaturas = new Set(percurso.paginas.map((p) => p.content));
  assert.equal(assinaturas.size, 4, 'houve pagina repetida');
});

await page.goto(`http://127.0.0.1:${porta}/`, { waitUntil: 'domcontentloaded' });
await page.evaluate(() => {
  window.__travado = true;
  // tambem neutraliza os numeros, para nao existir caminho alternativo
  for (const botao of document.querySelectorAll('.pg')) botao.onclick = null;
});
const travado = await percorrerPaginas(page, { ...comum, label: 'travado' });

await check('paginacao travada nao e reportada como completa', () => {
  assert.equal(travado.completou, false);
  assert.ok(travado.motivoParada, 'deveria dizer por que parou');
  assert.ok(travado.paginasVisitadas < 4, `visitou ${travado.paginasVisitadas}, deveria ter parado antes`);
});

console.log(`\n${failures.length === 0 ? 'todos os passos ok' : `${failures.length} falha(s)`}\n`);

await browser.close();
servidor.close();
fs.rmSync(process.env.STATE_DIR, { recursive: true, force: true });
process.exit(failures.length === 0 ? 0 : 1);
