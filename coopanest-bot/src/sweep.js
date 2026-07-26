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
import { casosDaPagina } from './tabela.js';

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
        const exato = candidatos.find((element) => {
          if (!visivel(element)) return false;
          const conteudo = (element.innerText || element.placeholder || '').trim();
          return conteudo === texto && element.children.length <= 3;
        });
        // o rotulo pode vir acompanhado de icone/seta no mesmo elemento:
        // se nao houver correspondencia exata, pega o menor que o contenha
        const contendo = candidatos
          .filter((element) => {
            if (!visivel(element)) return false;
            const conteudo = (element.innerText || element.placeholder || '').trim();
            return conteudo.includes(texto) && conteudo.length <= texto.length + 20;
          })
          .sort((a, b) => (a.innerText || '').length - (b.innerText || '').length);
        alvo = exato || contendo[0];
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
  if (!achou) {
    // nao e um <input>: descobre onde o portal mostra o intervalo, para eu
    // saber se da para digitar ou se e um calendario que precisa de clique
    const onde = await page.evaluate(() => {
      const re = /(\d{2}\/\d{2}\/\d{4})\s*[-–—]\s*(\d{2}\/\d{2}\/\d{4})/;
      const alvo = [...document.querySelectorAll('*')].find(
        (element) => element.offsetParent !== null && element.children.length === 0 && re.test(element.innerText || ''),
      );
      if (!alvo) return null;
      return { tag: alvo.tagName.toLowerCase(), texto: (alvo.innerText || '').trim().slice(0, 40) };
    });
    return {
      ok: false,
      motivo: onde
        ? `o intervalo aparece num <${onde.tag}> ("${onde.texto}"), nao num campo de texto`
        : 'campo de periodo nao encontrado',
    };
  }

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

/**
 * Assinatura da página: identificadores das primeiras linhas da tabela.
 * Serve para provar que o clique realmente trocou o conteúdo — comparar o texto
 * inteiro falha quando só a ordem muda, e comparar nada deixa entrar em loop.
 */
async function assinaturaLinhas(page) {
  return page.evaluate(() => {
    const linhas = [...document.querySelectorAll('table tbody tr, [role="row"]')].slice(0, 5);
    const chaves = linhas.map((linha) => {
      const celulas = [...linha.querySelectorAll('td, [role="cell"]')].slice(0, 3);
      return celulas.map((celula) => (celula.innerText || '').replace(/\s+/g, ' ').trim()).join('|');
    });
    return { assinatura: chaves.join(' /// '), linhas: document.querySelectorAll('table tbody tr, [role="row"]').length };
  });
}

/**
 * Procura o controle de "próxima página", em várias convenções:
 * rel=next, aria-label, classe .next, DataTables, ícone de seta e texto.
 * Devolve null quando não existe ou está desabilitado (última página).
 */
async function proximoControle(page) {
  const achou = await page.evaluate(() => {
    const visivel = (element) => element && element.offsetParent !== null;
    const desabilitado = (element) => {
      const classe = typeof element.className === 'string' ? element.className : '';
      return (
        element.hasAttribute('disabled') ||
        element.getAttribute('aria-disabled') === 'true' ||
        /\bdisabled\b/i.test(classe) ||
        Boolean(element.closest('.disabled, [aria-disabled="true"]'))
      );
    };

    const candidatos = [
      ...document.querySelectorAll(
        'a[rel="next"], .pagination a.next, .pagination li.next a, li.paginate_button.next, ' +
          '.paginate_button.next, [class*="next" i], [aria-label*="rox" i], [aria-label*="next" i], ' +
          '[title*="rox" i], [title*="next" i], button, a',
      ),
    ];

    const porTexto = (element) => {
      const alvo = (element.innerText || '').trim().toLowerCase();
      return ['próxima', 'proxima', 'próximo', 'proximo', 'next', '›', '»', '>'].includes(alvo);
    };
    const porAtributo = (element) => {
      const alvo = `${element.getAttribute('aria-label') || ''} ${element.getAttribute('title') || ''} ${
        element.getAttribute('rel') || ''
      } ${typeof element.className === 'string' ? element.className : ''}`.toLowerCase();
      return /next|próx|prox|seguinte/.test(alvo);
    };

    const alvo = candidatos.find((element) => visivel(element) && !desabilitado(element) && (porTexto(element) || porAtributo(element)));
    if (!alvo) {
      // existe controle, mas desabilitado? entao e a ultima pagina
      const bloqueado = candidatos.some((element) => visivel(element) && desabilitado(element) && (porTexto(element) || porAtributo(element)));
      return bloqueado ? 'ultima' : null;
    }

    document.querySelectorAll('[data-sweep="proxima"]').forEach((el) => el.removeAttribute('data-sweep'));
    alvo.setAttribute('data-sweep', 'proxima');
    return 'ok';
  });

  if (achou === 'ok') return page.locator('[data-sweep="proxima"]').first();
  return achou; // 'ultima' ou null
}

/** Percorre todas as páginas da tabela: botão "próxima" e, se não houver, os números. */
export async function percorrerPaginas(page, { rotuloResultados, maxPaginas, esperaMs, label, onPage, log }) {
  const paginas = [];
  const assinaturas = new Set();
  let completou = false;
  let motivoParada = '';

  const contagemTexto = await page.evaluate((marcador) => {
    const corpo = (document.body?.innerText || '').replace(/\s+/g, ' ');
    const posicao = corpo.indexOf(marcador);
    return posicao === -1 ? '' : corpo.slice(posicao, posicao + 120);
  }, rotuloResultados);

  const contagem = lerContagem(contagemTexto);
  let esperadas = contagem ? contagem.paginas : 0;
  if (contagem && !contagem.confiavel) esperadas = Math.max(await maiorBotaoPagina(page), 1);
  const limite = Math.min(esperadas || maxPaginas, maxPaginas);

  if (contagem) log(`${label}: ${contagem.total} resultado(s), ~${esperadas} pagina(s)`);

  for (let numero = 1; numero <= limite; numero += 1) {
    const { assinatura, linhas } = await assinaturaLinhas(page);

    if (assinaturas.has(assinatura)) {
      motivoParada = `pagina ${numero} repetiu o conteudo da anterior`;
      log(`${label}: ${motivoParada}`);
      break;
    }
    assinaturas.add(assinatura);

    const conteudo = await extractPageContent(page);
    // lê a tabela direto do DOM: não gasta IA e não perde linha
    const { casos } = await casosDaPagina(page);
    const titulo = `${label} — pagina ${numero}`;
    paginas.push({ url: titulo, content: conteudo, casos });
    onPage?.(titulo, conteudo);
    log(`${label}: pagina ${numero}/${limite} — ${linhas} linha(s), ${casos.length} caso(s) lido(s) da tabela`);

    if (numero === limite) {
      completou = true;
      break;
    }

    // 1) botão "próxima"; 2) número da próxima página
    const proxima = await proximoControle(page);
    let clicou = false;

    if (proxima === 'ultima') {
      completou = true;
      motivoParada = 'botao de proxima pagina desabilitado';
      break;
    }
    if (proxima) {
      await proxima.click({ timeout: 10_000 }).then(() => { clicou = true; }).catch(() => {});
    }

    if (!clicou) {
      const marcou = await marcar(page, 'pagina', {
        tipo: 'folhaExata',
        texto: String(numero + 1),
        seletores: 'button, a, li, span, div',
      });
      if (marcou) {
        await page
          .locator('[data-sweep="pagina"]')
          .first()
          .click({ timeout: 10_000 })
          .then(() => { clicou = true; })
          .catch(() => {});
      }
    }

    if (!clicou) {
      motivoParada = `nao achei como ir para a pagina ${numero + 1}`;
      log(`${label}: ${motivoParada}`);
      break;
    }

    await page.waitForTimeout(esperaMs);
  }

  return { paginas, completou, paginasVisitadas: paginas.length, esperadas, motivoParada };
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

  const percursos = [];

  // 1) sem filtro: costuma trazer tudo de uma vez
  const semFiltro = await percorrerPaginas(page, { ...comum, label: 'sem filtro' });
  paginas.push(...semFiltro.paginas);
  percursos.push({ label: 'sem filtro', ...semFiltro, paginas: undefined });

  // 2) uma passada por opção do filtro — status que o portal esconde no
  //    padrão (cancelada, por exemplo) só aparece assim
  const opcoes = await opcoesDoFiltro(page, s.rotuloFiltro || 'Selecione o item', log);
  for (const opcao of opcoes.slice(0, s.maxOpcoesFiltro ?? 10)) {
    if (!(await escolherOpcao(page, opcao))) {
      avisos.push(`nao consegui selecionar a opcao "${opcao}"`);
      continue;
    }
    const percurso = await percorrerPaginas(page, { ...comum, label: `filtro: ${opcao}` });
    paginas.push(...percurso.paginas);
    percursos.push({ label: `filtro: ${opcao}`, ...percurso, paginas: undefined });
    // reabre o dropdown para a próxima opção
    await opcoesDoFiltro(page, s.rotuloFiltro || 'Selecione o item', () => {});
  }

  const incompletos = percursos.filter((item) => !item.completou);
  for (const item of incompletos) avisos.push(`${item.label}: varredura incompleta — ${item.motivoParada}`);

  return {
    paginas,
    avisos,
    diagnostico: {
      periodoAplicado: periodo.ok,
      periodoDesejado: periodo.desejado || periodoDesejado(s.anosDeHistorico ?? 2),
      periodoNoPortal: periodo.depois || '',
      paginasVisitadas: percursos.reduce((soma, item) => soma + item.paginasVisitadas, 0),
      percursos,
      completou: incompletos.length === 0,
      filtrosVarridos: opcoes,
    },
  };
}

/** A tela tem cara de listagem com filtros? */
export async function pareceListagem(page, cfg) {
  const s = cfg.sweep || {};
  const marcador = s.rotuloResultados || 'Mostrando';
  const texto = await page
    .evaluate((termo) => {
      const corpo = (document.body?.innerText || '').replace(/\s+/g, ' ');
      const posicao = corpo.indexOf(termo);
      return posicao === -1 ? '' : corpo.slice(posicao, posicao + 120);
    }, marcador)
    .catch(() => '');
  return Boolean(lerContagem(texto));
}
