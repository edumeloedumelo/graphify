/**
 * Varredura de uma listagem com filtros — a tela "Controle de Guias" do portal.
 *
 * Tudo aqui é ancorado em TEXTO VISÍVEL ("Selecione o item", "Mostrando 1 a 10
 * de 36 resultados", "por página"), não em seletores CSS: o portal é um SPA com
 * classes geradas, que mudam a cada build. Texto de interface muda bem menos.
 *
 * Passos: período de N anos → maior "por página" → para cada opção do filtro,
 * percorre todas as páginas da tabela.
 */
import { extractPageContent, contentFingerprint } from './pagecontent.js';

const RANGE_RE = /(\d{2}\/\d{2}\/\d{4})\s*[-–—]\s*(\d{2}\/\d{2}\/\d{4})/;

function ddmmyyyy(date) {
  const dia = String(date.getDate()).padStart(2, '0');
  const mes = String(date.getMonth() + 1).padStart(2, '0');
  return `${dia}/${mes}/${date.getFullYear()}`;
}

/** "DD/MM/AAAA - DD/MM/AAAA" cobrindo os últimos N anos. */
export function periodoDesejado(anos = 2, hoje = new Date()) {
  const inicio = new Date(hoje.getTime());
  inicio.setFullYear(inicio.getFullYear() - anos);
  return `${ddmmyyyy(inicio)} - ${ddmmyyyy(hoje)}`;
}

/**
 * "Mostrando 1 a 10 de 36 resultados" → { total, porPagina, paginas }.
 *
 * O tamanho da página só pode ser deduzido daqui quando a leitura começa no
 * item 1: numa página final ("31 a 36 de 36") a fatia é menor que a página, e
 * inferir 6 por página daria 6 páginas em vez de 4. Nesse caso marca
 * confiavel=false para quem chamou contar os botões da paginação.
 */
export function lerContagem(texto) {
  const match = String(texto || '').match(/(\d+)\s*a\s*(\d+)\s*de\s*(\d+)/i);
  if (!match) return null;
  const de = Number(match[1]);
  const ate = Number(match[2]);
  const total = Number(match[3]);
  const confiavel = de === 1;
  const porPagina = Math.max(1, confiavel ? ate : ate - de + 1);
  return { total, porPagina, paginas: Math.max(1, Math.ceil(total / porPagina)), confiavel };
}

/** Maior número visível na paginação — usado quando o rodapé não é confiável. */
async function maiorBotaoPagina(page) {
  return page.evaluate(() => {
    const numeros = [...document.querySelectorAll('button, a, li, span')]
      .filter((element) => element.offsetParent !== null && element.children.length === 0)
      .map((element) => Number((element.innerText || '').trim()))
      .filter((valor) => Number.isInteger(valor) && valor > 0 && valor < 1000);
    return numeros.length ? Math.max(...numeros) : 0;
  });
}

/**
 * Marca no DOM o elemento que bate com o critério, para o Playwright clicar nele.
 * Sem `new Function`: portais com CSP restritiva bloqueiam eval.
 */
async function marcar(page, marca, criterio) {
  return page.evaluate(
    ({ marca: m, tipo, texto, seletores }) => {
      const visivel = (element) => element && element.offsetParent !== null;
      const candidatos = [...document.querySelectorAll(seletores)];
      let alvo = null;

      if (tipo === 'periodo') {
        const re = /(\d{2}\/\d{2}\/\d{4})\s*[-–—]\s*(\d{2}\/\d{2}\/\d{4})/;
        alvo = candidatos.find((input) => visivel(input) && re.test(input.value || ''));
      } else if (tipo === 'rotulo') {
        alvo = candidatos.find((element) => {
          if (!visivel(element)) return false;
          const conteudo = (element.innerText || element.placeholder || '').trim();
          return conteudo === texto && element.children.length <= 3;
        });
      } else if (tipo === 'folhaExata') {
        alvo = candidatos.find(
          (element) =>
            visivel(element) &&
            element.children.length === 0 &&
            (element.innerText || '').trim() === texto &&
            !element.hasAttribute('disabled') &&
            element.getAttribute('aria-disabled') !== 'true',
        );
      }

      if (!alvo) return false;
      document.querySelectorAll(`[data-sweep="${m}"]`).forEach((el) => el.removeAttribute('data-sweep'));
      alvo.setAttribute('data-sweep', m);
      return true;
    },
    { marca, ...criterio },
  );
}

/** Textos curtos visíveis na tela — usado para descobrir as opções de um dropdown. */
async function textosVisiveis(page) {
  return page.evaluate(() =>
    [...document.querySelectorAll('li, [role="option"], div, span, p, a')]
      .filter((element) => element.offsetParent !== null && element.children.length === 0)
      .map((element) => (element.innerText || '').trim())
      .filter((texto) => texto.length > 0 && texto.length <= 40),
  );
}

/** Ajusta o período de datas, quando a tela tiver esse campo. */
export async function aplicarPeriodo(page, anos, log = () => {}) {
  const alvo = periodoDesejado(anos);

  const achou = await marcar(page, 'periodo', { tipo: 'periodo', seletores: 'input' });
  if (!achou) return { ok: false, motivo: 'campo de periodo nao encontrado' };

  const campo = page.locator('[data-sweep="periodo"]').first();
  const antes = await campo.inputValue().catch(() => '');

  await campo.fill(alvo).catch(() => {});
  await campo.press('Enter').catch(() => {});
  await page.waitForTimeout(1200);

  const depois = await campo.inputValue().catch(() => '');
  const ok = RANGE_RE.test(depois) && depois.replace(/\s/g, '') === alvo.replace(/\s/g, '');
  log(`periodo: "${antes}" -> "${depois}" (desejado "${alvo}")`);
  return { ok, antes, depois, desejado: alvo };
}

/** Aumenta o "por página" para o maior valor disponível (menos páginas para percorrer). */
export async function aumentarPorPagina(page, rotulo, log = () => {}) {
  const escolhido = await page.evaluate((termo) => {
    const alvo = String(termo).toLowerCase();
    for (const select of document.querySelectorAll('select')) {
      const contexto = `${select.closest('div')?.innerText || ''} ${select.getAttribute('aria-label') || ''}`;
      if (!contexto.toLowerCase().includes(alvo)) continue;

      const numericas = [...select.options]
        .map((opcao) => ({ opcao, valor: parseInt(opcao.text, 10) }))
        .filter((item) => Number.isFinite(item.valor));
      if (numericas.length === 0) continue;

      const maior = numericas.sort((a, b) => b.valor - a.valor)[0];
      select.value = maior.opcao.value;
      select.dispatchEvent(new Event('change', { bubbles: true }));
      return maior.valor;
    }
    return 0;
  }, rotulo);

  if (escolhido) {
    await page.waitForTimeout(1200);
    log(`itens por pagina: ${escolhido}`);
  }
  return escolhido;
}

/** Abre o dropdown de filtro e devolve as opções que aparecerem. */
export async function opcoesDoFiltro(page, rotulo, log = () => {}) {
  const antes = new Set(await textosVisiveis(page));

  const abriu = await marcar(page, 'filtro', {
    tipo: 'rotulo',
    texto: rotulo,
    seletores: 'div, button, span, input, [role="combobox"]',
  });
  if (!abriu) {
    log(`filtro "${rotulo}" nao encontrado`);
    return [];
  }

  await page.locator('[data-sweep="filtro"]').first().click({ timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(800);

  const depois = await textosVisiveis(page);
  const novas = [...new Set(depois.filter((texto) => !antes.has(texto)))];
  log(`filtro "${rotulo}": ${novas.length} opcao(oes) — ${novas.join(', ')}`);
  return novas;
}

/** Escolhe uma opção do dropdown já aberto. */
export async function escolherOpcao(page, texto) {
  const achou = await marcar(page, 'opcao', {
    tipo: 'folhaExata',
    texto,
    seletores: 'li, [role="option"], div, span, p, a',
  });
  if (!achou) return false;

  await page.locator('[data-sweep="opcao"]').first().click({ timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(1500);
  return true;
}

/** Percorre todas as páginas da tabela clicando nos números da paginação. */
export async function percorrerPaginas(page, { rotuloResultados, maxPaginas, esperaMs, label, onPage, log }) {
  const paginas = [];
  const vistos = new Set();

  const capturar = async (numero) => {
    const conteudo = await extractPageContent(page);
    const digital = contentFingerprint(conteudo);
    if (vistos.has(digital)) return false;
    vistos.add(digital);
    const titulo = `${label} — pagina ${numero}`;
    paginas.push({ url: titulo, content: conteudo });
    onPage?.(titulo, conteudo);
    return true;
  };

  const contagemTexto = await page.evaluate((marcador) => {
    const alvo = [...document.querySelectorAll('*')].find(
      (element) => element.children.length === 0 && (element.innerText || '').includes(marcador),
    );
    return alvo ? alvo.innerText : '';
  }, rotuloResultados);

  const contagem = lerContagem(contagemTexto);
  let estimativa = contagem ? contagem.paginas : 1;
  if (contagem && !contagem.confiavel) {
    // rodape numa pagina do meio/fim: conta os botoes em vez de deduzir
    estimativa = Math.max(await maiorBotaoPagina(page), 1);
  }
  const total = Math.min(estimativa, maxPaginas);
  if (contagem) log(`${label}: ${contagem.total} resultado(s) em ${total} pagina(s)`);

  await capturar(1);

  for (let numero = 2; numero <= total; numero += 1) {
    const clicou = await marcar(page, 'pagina', {
      tipo: 'folhaExata',
      texto: String(numero),
      seletores: 'button, a, li, span, div',
    });
    if (!clicou) {
      log(`${label}: nao achei o botao da pagina ${numero}, parando`);
      break;
    }

    await page.locator('[data-sweep="pagina"]').first().click({ timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(esperaMs);

    if (!(await capturar(numero))) {
      log(`${label}: pagina ${numero} repetiu o conteudo, parando`);
      break;
    }
  }

  return paginas;
}

/**
 * Varre a listagem inteira: período, itens por página e cada opção do filtro,
 * percorrendo todas as páginas de cada combinação.
 */
export async function sweepListing(page, { cfg, log = () => {}, onPage } = {}) {
  const s = cfg.sweep || {};
  const paginas = [];
  const avisos = [];

  const periodo = await aplicarPeriodo(page, s.anosDeHistorico ?? 2, log);
  if (!periodo.ok) avisos.push(`periodo nao aplicado (${periodo.motivo || `ficou "${periodo.depois}"`})`);

  await aumentarPorPagina(page, s.rotuloPorPagina || 'por página', log);

  const comum = {
    rotuloResultados: s.rotuloResultados || 'Mostrando',
    maxPaginas: s.maxPaginas ?? 40,
    esperaMs: s.esperaMs ?? 1500,
    onPage,
    log,
  };

  // 1) sem filtro: costuma trazer tudo de uma vez
  paginas.push(...(await percorrerPaginas(page, { ...comum, label: 'sem filtro' })));

  // 2) uma passada por opção do filtro — status que o portal esconde no
  //    padrão (cancelada, por exemplo) só aparece assim
  const opcoes = await opcoesDoFiltro(page, s.rotuloFiltro || 'Selecione o item', log);
  for (const opcao of opcoes.slice(0, s.maxOpcoesFiltro ?? 10)) {
    if (!(await escolherOpcao(page, opcao))) {
      avisos.push(`nao consegui selecionar a opcao "${opcao}"`);
      continue;
    }
    paginas.push(...(await percorrerPaginas(page, { ...comum, label: `filtro: ${opcao}` })));
    // reabre o dropdown para a próxima opção
    await opcoesDoFiltro(page, s.rotuloFiltro || 'Selecione o item', () => {});
  }

  return { paginas, avisos };
}

/** A tela tem cara de listagem com filtros? */
export async function pareceListagem(page, cfg) {
  const s = cfg.sweep || {};
  const marcador = s.rotuloResultados || 'Mostrando';
  return page
    .evaluate((termo) => (document.body?.innerText || '').includes(termo), marcador)
    .catch(() => false);
}
