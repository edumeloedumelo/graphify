/**
 * Relatório do DOM real de uma página do portal.
 *
 * Existe porque o ambiente onde este código é desenvolvido não alcança o
 * portal: sem isso, todo seletor seria chute. O relatório sai por
 * GET /inspecionar e traz o que é preciso para escrever seletores de verdade —
 * campos, botões, candidatos a paginação e a filtros de data.
 *
 * Nunca inclui valores digitados em campos de senha nem o conteúdo das linhas
 * da tabela: só estrutura.
 */

/**
 * @param {import('playwright').Page} page
 * @returns {Promise<object>} estrutura da página, pronta para colar numa conversa
 */
export async function inspectPage(page) {
  return page.evaluate(() => {
    // definida aqui dentro de proposito: passar a funcao como string exigiria
    // new Function, que portais com CSP restritiva bloqueiam
    const descrever = (element) => {
      const partes = [element.tagName.toLowerCase()];
      if (element.type) partes.push(`type=${element.type}`);
      if (element.name) partes.push(`name=${element.name}`);
      if (element.id) partes.push(`id=${element.id}`);
      const classe = typeof element.className === 'string' ? element.className.trim() : '';
      if (classe) partes.push(`class="${classe.slice(0, 80)}"`);
      if (element.placeholder) partes.push(`placeholder="${element.placeholder}"`);
      const rotulo = element.getAttribute?.('aria-label');
      if (rotulo) partes.push(`aria-label="${rotulo}"`);
      const papel = element.getAttribute?.('role');
      if (papel) partes.push(`role=${papel}`);
      return partes.join(' ');
    };
    const visivel = (element) => element && element.offsetParent !== null;
    const texto = (element) => (element.innerText || '').replace(/\s+/g, ' ').trim();

    const corpo = (document.body?.innerText || '').replace(/\s+/g, ' ').trim();

    // --- campos ---
    const campos = [...document.querySelectorAll('input, select, textarea')]
      .filter((element) => element.type !== 'hidden')
      .map((element) => {
        const base = descrever(element);
        const extras = [];
        if (element.tagName === 'SELECT') {
          extras.push('opcoes=[' + [...element.options].map((o) => o.text.trim()).join(' | ') + ']');
        }
        // valor só quando não for senha, e truncado
        if (element.type !== 'password' && element.value) {
          extras.push('valor="' + String(element.value).slice(0, 40) + '"');
        }
        if (!visivel(element)) extras.push('OCULTO');
        return [base, ...extras].join(' ');
      });

    // --- botões e elementos clicáveis com texto curto ---
    const clicaveis = [...document.querySelectorAll('button, a, [role="button"], [role="tab"], [role="option"]')]
      .filter(visivel)
      .map((element) => ({ descricao: descrever(element), texto: texto(element).slice(0, 40) }))
      .filter((item) => item.texto.length > 0 || item.descricao.includes('aria-label'))
      .slice(0, 120);

    // --- candidatos a paginação ---
    const numeros = [...document.querySelectorAll('button, a, li, span, div')]
      .filter((element) => visivel(element) && element.children.length === 0)
      .filter((element) => /^\d{1,3}$/.test(texto(element)))
      .map((element) => ({
        numero: texto(element),
        descricao: descrever(element),
        pai: element.parentElement ? descrever(element.parentElement) : '',
      }))
      .slice(0, 30);

    const setas = [...document.querySelectorAll('button, a, [role="button"]')]
      .filter(visivel)
      .filter((element) => {
        const alvo = (
          texto(element) +
          ' ' +
          (element.getAttribute('aria-label') || '') +
          ' ' +
          (element.getAttribute('title') || '') +
          ' ' +
          (typeof element.className === 'string' ? element.className : '')
        ).toLowerCase();
        return /next|prox|próx|seguinte|forward|chevron|arrow|»|>/.test(alvo);
      })
      .map((element) => ({
        descricao: descrever(element),
        texto: texto(element).slice(0, 20),
        desabilitado:
          element.disabled === true ||
          element.getAttribute('aria-disabled') === 'true' ||
          (typeof element.className === 'string' ? element.className : '').split(/\s+/).includes('disabled'),
      }))
      .slice(0, 20);

    // --- textos com cara de data / intervalo ---
    const reIntervalo = /(\d{1,2}\/\d{1,2}\/\d{2,4})\s*[-–—a]\s*(\d{1,2}\/\d{1,2}\/\d{2,4})/;
    const datas = [...document.querySelectorAll('*')]
      .filter((element) => visivel(element) && element.children.length === 0)
      .filter((element) => reIntervalo.test(texto(element)) || /\d{2}\/\d{2}\/\d{4}/.test(texto(element)))
      .map((element) => ({ descricao: descrever(element), texto: texto(element).slice(0, 60) }))
      .slice(0, 15);

    // --- tabelas ---
    const tabelas = [...document.querySelectorAll('table')].map((tabela) => ({
      descricao: descrever(tabela),
      colunas: [...tabela.querySelectorAll('thead th, thead td')].map((celula) => texto(celula)),
      linhas: tabela.querySelectorAll('tbody tr').length,
      // primeira coluna das 3 primeiras linhas: costuma ser o identificador
      amostraPrimeiraColuna: [...tabela.querySelectorAll('tbody tr')]
        .slice(0, 3)
        .map((linha) => texto(linha.querySelector('td'))),
      linhasComLink: [...tabela.querySelectorAll('tbody tr')].filter((linha) => linha.querySelector('a[href]')).length,
      exemploLink: (() => {
        const link = tabela.querySelector('tbody tr a[href]');
        return link ? link.getAttribute('href') : '';
      })(),
    }));

    // --- grids que não são <table> ---
    const grids = [...document.querySelectorAll('[role="grid"], [role="table"], [class*="atagrid" i], [class*="table" i]')]
      .filter(visivel)
      .map(descrever)
      .slice(0, 10);

    const contagem = corpo.match(/Mostrando[^.]{0,60}/i);

    return {
      url: location.href,
      titulo: document.title,
      textoContagem: contagem ? contagem[0] : '',
      campos,
      clicaveis,
      paginacao: { numeros, setas },
      datas,
      tabelas,
      grids,
      trechoDoTexto: corpo.slice(0, 600),
    };
  });
}
