/**
 * Testes de privacidade, autorização e integridade da sincronização.
 *
 *   CHROMIUM_PATH=/caminho/para/chrome node scripts/e2e-integridade.js
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

// dados propositalmente identificáveis: se algum deles vazar na resposta do
// inspetor, o teste falha
const PACIENTES = ['Camila Ferreira Arcanjo da Silva', 'Jessica Andrade Ferreira', 'Suellen Leocadia dos Santos'];
const CPSAS = ['2026246974', '2026246973', '2026246970'];

const PAGINA = `<!doctype html><html><head><title>Home</title></head><body>
<h2>Controle de Guias - Cooperados</h2>
<div id="headlessui-popover-button-v-0-2" role="button">26/01/2025 - 26/07/2026 Periodo de Guias</div>
<div id="painel" role="dialog" style="display:none">
  <button aria-label="Mês anterior">‹</button><span>Julho 2026</span><button aria-label="Próximo mês">›</button>
  <table><tr><td><button>1</button></td><td><button>2</button></td></tr></table>
  <button>Aplicar</button>
</div>
<div>Guias por página: <select id="porPagina"><option>5</option><option selected>10</option><option>50</option></select></div>
<table><thead><tr><th>CPSA</th><th>Status</th><th>Paciente</th><th>Data Cirurgia</th><th>Valor Faturado</th><th>Ações</th></tr></thead>
<tbody>
${PACIENTES.map(
  (nome, i) => `<tr>
  <td>${CPSAS[i]}</td><td>Aguardando Pagamento</td><td>${nome}</td><td>1${i + 1}/07/2026</td><td>R$ 510,00</td>
  <td><button aria-label="Ações de ${nome}" class="acoes"><svg data-icon="dots"></svg></button></td>
</tr>`,
).join('')}
</tbody></table>
<span>Mostrando</span> <b>1</b> <span>a</span> <b>3</b> <span>de</span> <b>3</b> <span>resultados</span>
<script>
document.getElementById('headlessui-popover-button-v-0-2').onclick = () => {
  document.getElementById('painel').style.display = 'block';
};
</script></body></html>`;

const servidor = http.createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(PAGINA);
});
await new Promise((resolve) => servidor.listen(0, '127.0.0.1', resolve));
const porta = servidor.address().port;

process.env.STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'coopanest-integridade-'));

const { chromium } = await import('playwright');
const { inspectPage, inspecionarAberto, inspecionarAcoes, abrirElemento, mascarar } = await import(
  '../src/inspector.js'
);
const { inspetorHabilitado, autorizado, motivoRecusarUrl } = await import('../src/inspectorguard.js');
const { cpsasDuplicadas, caseKey, temIdentificadorDoPortal } = await import('../src/diff.js');
const { percorrerPaginas } = await import('../src/sweep.js');

const failures = [];
async function check(nome, fn) {
  try {
    await fn();
    console.log(`  ok  ${nome}`);
  } catch (err) {
    failures.push(nome);
    console.error(`  FAIL ${nome}: ${err.message}`);
  }
}

const browser = await chromium.launch({
  headless: true,
  args: ['--no-sandbox'],
  ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
});
const page = await browser.newPage();
await page.goto(`http://127.0.0.1:${porta}/`, { waitUntil: 'domcontentloaded' });

console.log('\nprivacidade do inspetor\n');

const relatorio = await inspectPage(page);
const serializado = JSON.stringify(relatorio);

await check('a resposta nao contem nome de paciente', () => {
  for (const nome of PACIENTES) {
    assert.ok(!serializado.includes(nome), `vazou "${nome}"`);
    assert.ok(!serializado.includes(nome.split(' ')[0]), `vazou o primeiro nome "${nome.split(' ')[0]}"`);
  }
});

await check('a resposta nao contem CPSA nem valores das linhas', () => {
  for (const cpsa of CPSAS) assert.ok(!serializado.includes(cpsa), `vazou a CPSA ${cpsa}`);
  assert.ok(!serializado.includes('R$ 510'), 'vazou valor faturado');
});

await check('a resposta nao tem campo de texto livre da pagina', () => {
  assert.equal(relatorio.trechoDoTexto, undefined, 'trechoDoTexto voltou a existir');
  assert.equal(relatorio.tabelas[0].amostraPrimeiraColuna, undefined, 'amostra de linha voltou a existir');
});

await check('a estrutura util continua saindo', () => {
  // a pagina tem duas tabelas (calendario do popover + listagem): procura a de dados
  const listagem = relatorio.tabelas.find((tabela) => tabela.colunas.includes('CPSA'));
  assert.ok(listagem, 'nao achei a tabela de guias');
  assert.deepEqual(listagem.colunas, [
    'CPSA',
    'Status',
    'Paciente',
    'Data Cirurgia',
    'Valor Faturado',
    'Ações',
  ]);
  assert.match(relatorio.textoContagem, /Mostrando 1 a 3 de 3 resultados/);
  assert.ok(relatorio.campos.some((campo) => campo.includes('select')), 'faltou o select de itens por pagina');
});

await check('mascarar troca data, dinheiro e numero longo', () => {
  assert.equal(mascarar('12/07/2026'), 'DD/MM/AAAA');
  assert.equal(mascarar('R$ 4.200,00'), 'R$ N');
  assert.equal(mascarar('2026246974'), 'NNNN');
});

console.log('\ninspecao da coluna Acoes e do popover\n');

const acoes = await inspecionarAcoes(page);
await check('descreve a coluna Acoes sem citar o paciente', () => {
  assert.equal(acoes.encontrou, true);
  assert.equal(acoes.controlesPorLinha, 1);
  assert.equal(acoes.controles[0].temAriaLabel, true, 'deveria sinalizar que existe aria-label');
  const texto = JSON.stringify(acoes);
  for (const nome of PACIENTES) assert.ok(!texto.includes(nome), `vazou "${nome}" nas acoes`);
  assert.deepEqual(acoes.controles[0].icones, ['dots']);
});

await abrirElemento(page, 'Periodo de Guias');
const painel = await inspecionarAberto(page);
await check('descreve o popover aberto com datas mascaradas', () => {
  assert.equal(painel.encontrou, true);
  assert.equal(painel.temNavegacaoMes, true, 'deveria detectar navegacao de mes');
  assert.ok(painel.botoes.some((botao) => botao.texto === 'Aplicar'), 'faltou o botao Aplicar');
  assert.ok(!/\d{2}\/\d{2}\/\d{4}/.test(JSON.stringify(painel)), 'saiu data sem mascarar');
});

console.log('\nautorizacao do endpoint\n');

const requisicao = (cabecalho) => ({ get: (nome) => (nome.toLowerCase() === 'authorization' ? cabecalho : '') });

await check('sem token configurado o endpoint fica fechado', () => {
  delete process.env.INSPECTOR_TOKEN;
  const resposta = autorizado(requisicao('Bearer qualquer'));
  assert.equal(resposta.ok, false);
  assert.equal(resposta.status, 403);
});

await check('sem cabecalho Authorization devolve 401', () => {
  process.env.INSPECTOR_TOKEN = 'segredo';
  assert.equal(autorizado(requisicao('')).status, 401);
  assert.equal(autorizado(requisicao('Bearer errado')).status, 401);
  assert.equal(autorizado(requisicao('Bearer segredo')).ok, true);
});

await check('INSPECTOR_ENABLED=false desliga o endpoint', () => {
  process.env.INSPECTOR_ENABLED = 'false';
  assert.equal(inspetorHabilitado(), false);
  delete process.env.INSPECTOR_ENABLED;
  assert.equal(inspetorHabilitado(), true);
});

await check('so https em host autorizado da Coopanest', () => {
  const permitidos = ['portal1.coopanestrio.org.br'];
  assert.equal(motivoRecusarUrl('https://portal1.coopanestrio.org.br/app/home', permitidos), null);
  assert.match(motivoRecusarUrl('http://portal1.coopanestrio.org.br/app', permitidos), /https/);
  assert.match(motivoRecusarUrl('https://exemplo.com/', permitidos), /nao autorizado/);
  assert.match(motivoRecusarUrl('https://localhost/', permitidos), /local/);
  assert.match(motivoRecusarUrl('https://127.0.0.1/', permitidos), /IP/);
  assert.match(motivoRecusarUrl('https://192.168.1.10/', permitidos), /IP/);
  assert.match(motivoRecusarUrl('file:///etc/passwd', permitidos), /https/);
});

console.log('\nintegridade das CPSAs\n');

await check('CPSA e a chave, e o nome do paciente nao entra nela', () => {
  const caso = { guia: '2026246974', paciente: 'Camila', data: '17/07/2026', procedimento: 'X' };
  assert.equal(caseKey(caso), 'g2026246974');
  assert.equal(caseKey({ ...caso, paciente: 'Outro Nome', data: '01/01/2020' }), 'g2026246974');
  assert.equal(temIdentificadorDoPortal(caso), true);
});

await check('caso legado sem CPSA usa a chave composta como fallback', () => {
  const legado = { paciente: 'Maria', data: '12/07/2026', procedimento: 'Colecistectomia' };
  assert.equal(temIdentificadorDoPortal(legado), false);
  assert.match(caseKey(legado), /^[0-9a-f]{10}$/);
});

await check('CPSA repetida na leitura e detectada', () => {
  assert.deepEqual(cpsasDuplicadas([{ guia: '2026246974' }, { guia: '2026246974' }, { guia: '2026246973' }]), [
    '2026246974',
  ]);
  assert.deepEqual(cpsasDuplicadas([{ guia: '2026246974' }, { guia: '2026246973' }]), []);
});

console.log('\nreconciliacao da paginacao\n');

const comum = { rotuloResultados: 'Mostrando', maxPaginas: 20, esperaMs: 80, log: () => {} };
const percurso = await percorrerPaginas(page, { ...comum, label: 'unica' });

await check('coleta as 3 guias e alcanca a ultima pagina', () => {
  assert.equal(percurso.totalInformado, 3);
  assert.equal(percurso.coletadas, 3);
  assert.equal(percurso.ultimaPaginaAlcancada, true);
  assert.equal(percurso.completou, true, `erros: ${percurso.erros.join('; ')}`);
});

console.log(`\n${failures.length === 0 ? 'todos os passos ok' : `${failures.length} falha(s)`}\n`);

await browser.close();
servidor.close();
fs.rmSync(process.env.STATE_DIR, { recursive: true, force: true });
process.exit(failures.length === 0 ? 0 : 1);
