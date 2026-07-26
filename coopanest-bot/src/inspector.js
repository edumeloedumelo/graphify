/**
 * Relatório da ESTRUTURA de uma página do portal — nunca do seu conteúdo.
 *
 * Existe porque o ambiente onde este código é desenvolvido não alcança o
 * portal: sem isso, todo seletor seria chute.
 *
 * REGRA DE PRIVACIDADE. A versão anterior deste arquivo prometia no cabeçalho
 * não devolver conteúdo de linha e devolvia: `trechoDoTexto` saía com nome de
 * paciente, CPSA, data, valor e convênio. As três regras abaixo existem para
 * que isso não dependa de disciplina de quem edita:
 *
 *  1. nada dentro de <tbody> contribui com texto — linha de tabela é dado de
 *     paciente por definição;
 *  2. todo texto que sai daqui passa por `mascarar`: data vira DD/MM/AAAA,
 *     dinheiro vira R$ N, sequência de 4+ dígitos vira NNNN;
 *  3. de elementos dentro de linhas saem apenas atributos estruturais — tag,
 *     role, classe, ícone — e nunca o valor de aria-label ou title.
 */

/** Datas, valores e números longos saem mascarados. */
export function mascarar(texto) {
  return String(texto || '')
    .replace(/\d{1,2}\/\d{1,2}\/\d{2,4}/g, 'DD/MM/AAAA')
    .replace(/R\$\s*[\d.,]+/gi, 'R$ N')
    .replace(/\d{4,}/g, 'NNNN')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60);
}

/** Descreve a forma de um JSON sem expor valores — só chaves e tamanhos. */
export function formaDoJson(texto) {
  let dados;
  try {
    dados = JSON.parse(texto);
  } catch {
    return 'nao e JSON';
  }

  const descrever = (valor, profundidade = 0) => {
    if (Array.isArray(valor)) {
      const primeiro = valor[0];
      const dentro = primeiro && typeof primeiro === 'object' ? Object.keys(primeiro).join(', ') : typeof primeiro;
      return `array(${valor.length}) de { ${dentro} }`;
    }
    if (valor && typeof valor === 'object') {
      if (profundidade >= 1) return `{ ${Object.keys(valor).join(', ')} }`;
      return Object.entries(valor)
        .map(([chave, item]) => `${chave}: ${descrever(item, profundidade + 1)}`)
        .join(' | ');
    }
    return typeof valor;
  };

  return descrever(dados);
}

/** Clica num elemento (por id ou texto) para abrir popover/menu antes de inspecionar. */
export async function abrirElemento(page, alvo) {
  if (!alvo) return { clicou: false };

  const marcou = await page.evaluate((termo) => {
      // helpers inline: passar como string exigiria eval, que portais com CSP
      // restritiva bloqueiam
      const visivel = (element) => element && element.offsetParent !== null;
      const emLinha = (element) => Boolean(element.closest('tbody, [role="row"]'));
      const mascarar = (texto) =>
        String(texto || '')
            .replace(/\d{1,2}\/\d{1,2}\/\d{2,4}/g, 'DD/MM/AAAA')
            .replace(/R\$\s*[\d.,]+/gi, 'R$ N')
            .replace(/\d{4,}/g, 'NNNN')
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 60);
      const textoSeguro = (element) => (emLinha(element) ? '' : mascarar(element.innerText));
      const descrever = (element) => {
        const partes = [element.tagName.toLowerCase()];
        if (element.type) partes.push(`type=${element.type}`);
        if (element.name) partes.push(`name=${element.name}`);
        if (element.id) partes.push(`id=${element.id}`);
        const classe = typeof element.className === 'string' ? element.className.trim() : '';
        if (classe) partes.push(`class="${classe.slice(0, 80)}"`);
        if (element.placeholder) partes.push(`placeholder="${mascarar(element.placeholder)}"`);
        const papel = element.getAttribute?.('role');
        if (papel) partes.push(`role=${papel}`);
        const rotulo = element.getAttribute?.('aria-label');
        // dentro de linha o aria-label costuma citar o paciente: so o fato de existir
        if (rotulo) partes.push(emLinha(element) ? 'tem-aria-label' : `aria-label="${mascarar(rotulo)}"`);
        return partes.join(' ');
      };

      const porId = document.getElementById(termo);
      const candidatos = [...document.querySelectorAll('button, a, div, span, [role="button"], [role="combobox"]')];
      const porTexto = candidatos
        .filter((element) => visivel(element) && !emLinha(element) && (element.innerText || '').includes(termo))
        .sort((a, b) => (a.innerText || '').length - (b.innerText || '').length)[0];

      const escolhido = porId && visivel(porId) ? porId : porTexto;
      if (!escolhido) return false;
      escolhido.setAttribute('data-inspecao', 'abrir');
      return true;
  }, alvo);

  if (!marcou) return { clicou: false, motivo: `nao achei "${alvo}" fora das linhas da tabela` };

  await page.locator('[data-inspecao="abrir"]').first().click({ timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(1200);
  return { clicou: true, alvo };
}

/** Estrutura do painel que abriu (popover, listbox, calendário). */
export async function inspecionarAberto(page) {
  return page.evaluate(() => {
    // helpers inline: passar como string exigiria eval, que portais com CSP
    // restritiva bloqueiam
    const visivel = (element) => element && element.offsetParent !== null;
    const emLinha = (element) => Boolean(element.closest('tbody, [role="row"]'));
    const mascarar = (texto) =>
      String(texto || '')
        .replace(/\d{1,2}\/\d{1,2}\/\d{2,4}/g, 'DD/MM/AAAA')
        .replace(/R\$\s*[\d.,]+/gi, 'R$ N')
        .replace(/\d{4,}/g, 'NNNN')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 60);
    const textoSeguro = (element) => (emLinha(element) ? '' : mascarar(element.innerText));
    const descrever = (element) => {
      const partes = [element.tagName.toLowerCase()];
      if (element.type) partes.push(`type=${element.type}`);
      if (element.name) partes.push(`name=${element.name}`);
      if (element.id) partes.push(`id=${element.id}`);
      const classe = typeof element.className === 'string' ? element.className.trim() : '';
      if (classe) partes.push(`class="${classe.slice(0, 80)}"`);
      if (element.placeholder) partes.push(`placeholder="${mascarar(element.placeholder)}"`);
      const papel = element.getAttribute?.('role');
      if (papel) partes.push(`role=${papel}`);
      const rotulo = element.getAttribute?.('aria-label');
      // dentro de linha o aria-label costuma citar o paciente: so o fato de existir
      if (rotulo) partes.push(emLinha(element) ? 'tem-aria-label' : `aria-label="${mascarar(rotulo)}"`);
      return partes.join(' ');
    };

    const paineis = [
      ...document.querySelectorAll(
        '[role="dialog"], [role="listbox"], [role="menu"], [role="grid"], [id*="popover-panel"], [id*="listbox-options"], [data-headlessui-state]',
      ),
    ].filter((element) => visivel(element) && !emLinha(element));

    const painel = paineis[paineis.length - 1];
    if (!painel) return { encontrou: false };

    const dentro = (seletor) => [...painel.querySelectorAll(seletor)].filter(visivel);

    return {
      encontrou: true,
      painel: descrever(painel),
      campos: dentro('input, select, textarea').map(descrever),
      botoes: dentro('button, [role="button"]')
        .map((element) => ({ descricao: descrever(element), texto: textoSeguro(element) }))
        .slice(0, 60),
      opcoes: dentro('[role="option"], li').map(textoSeguro).filter(Boolean).slice(0, 30),
      temCalendario: dentro('[role="grid"], table, [class*="calend" i], [class*="datepicker" i]').length > 0,
      temNavegacaoMes: dentro('button, [role="button"]').some((element) =>
        /anterior|proximo|próximo|prev|next|«|»|‹|›/i.test(
          `${element.innerText || ''} ${element.getAttribute('aria-label') || ''}`,
        ),
      ),
      textoDoPainel: mascarar(painel.innerText).slice(0, 300),
    };
  });
}

/** Estrutura da coluna "Ações": só atributos, nunca dado do paciente. */
export async function inspecionarAcoes(page) {
  return page.evaluate(() => {
    // helpers inline: passar como string exigiria eval, que portais com CSP
    // restritiva bloqueiam
    const visivel = (element) => element && element.offsetParent !== null;
    const emLinha = (element) => Boolean(element.closest('tbody, [role="row"]'));
    const mascarar = (texto) =>
      String(texto || '')
        .replace(/\d{1,2}\/\d{1,2}\/\d{2,4}/g, 'DD/MM/AAAA')
        .replace(/R\$\s*[\d.,]+/gi, 'R$ N')
        .replace(/\d{4,}/g, 'NNNN')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 60);
    const textoSeguro = (element) => (emLinha(element) ? '' : mascarar(element.innerText));
    const descrever = (element) => {
      const partes = [element.tagName.toLowerCase()];
      if (element.type) partes.push(`type=${element.type}`);
      if (element.name) partes.push(`name=${element.name}`);
      if (element.id) partes.push(`id=${element.id}`);
      const classe = typeof element.className === 'string' ? element.className.trim() : '';
      if (classe) partes.push(`class="${classe.slice(0, 80)}"`);
      if (element.placeholder) partes.push(`placeholder="${mascarar(element.placeholder)}"`);
      const papel = element.getAttribute?.('role');
      if (papel) partes.push(`role=${papel}`);
      const rotulo = element.getAttribute?.('aria-label');
      // dentro de linha o aria-label costuma citar o paciente: so o fato de existir
      if (rotulo) partes.push(emLinha(element) ? 'tem-aria-label' : `aria-label="${mascarar(rotulo)}"`);
      return partes.join(' ');
    };

    // a primeira <table> do DOM pode ser o calendario de um popover: vale a
    // que tem mais linhas de corpo, que e a listagem de verdade
    const tabela = [...document.querySelectorAll('table')].sort(
      (a, b) => b.querySelectorAll('tbody tr').length - a.querySelectorAll('tbody tr').length,
    )[0];
    if (!tabela) return { encontrou: false };

    const cabecalhos = [...tabela.querySelectorAll('thead th, thead td')].map((celula) =>
      (celula.innerText || '').trim(),
    );
    const indiceAcoes = cabecalhos.findIndex((titulo) => /a[cç][oõ]es/i.test(titulo));
    const primeiraLinha = tabela.querySelector('tbody tr');
    if (!primeiraLinha) return { encontrou: false };

    const celula =
      indiceAcoes >= 0
        ? primeiraLinha.querySelectorAll('td')[indiceAcoes]
        : primeiraLinha.querySelector('td:last-child');
    if (!celula) return { encontrou: false };

    const controles = [...celula.querySelectorAll('button, a, [role="button"]')];
    return {
      encontrou: true,
      colunaAcoes: indiceAcoes,
      controlesPorLinha: controles.length,
      controles: controles.map((element) => ({
        descricao: descrever(element),
        temAriaLabel: Boolean(element.getAttribute('aria-label')),
        temTitle: Boolean(element.getAttribute('title')),
        temHref: element.tagName === 'A' && Boolean(element.getAttribute('href')),
        icones: [...element.querySelectorAll('svg')].map(
          (svg) => svg.getAttribute('data-icon') || (typeof svg.className === 'string' ? svg.className : 'svg'),
        ),
      })),
      linhasComLink: [...tabela.querySelectorAll('tbody tr')].filter((linha) => linha.querySelector('a[href]')).length,
    };
  });
}

/**
 * Estrutura da página: campos, clicáveis, paginação e cabeçalho das tabelas.
 * Sem conteúdo de linha e sem texto livre da tela.
 */
export async function inspectPage(page) {
  return page.evaluate(() => {
    // helpers inline: passar como string exigiria eval, que portais com CSP
    // restritiva bloqueiam
    const visivel = (element) => element && element.offsetParent !== null;
    const emLinha = (element) => Boolean(element.closest('tbody, [role="row"]'));
    const mascarar = (texto) =>
      String(texto || '')
        .replace(/\d{1,2}\/\d{1,2}\/\d{2,4}/g, 'DD/MM/AAAA')
        .replace(/R\$\s*[\d.,]+/gi, 'R$ N')
        .replace(/\d{4,}/g, 'NNNN')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 60);
    const textoSeguro = (element) => (emLinha(element) ? '' : mascarar(element.innerText));
    const descrever = (element) => {
      const partes = [element.tagName.toLowerCase()];
      if (element.type) partes.push(`type=${element.type}`);
      if (element.name) partes.push(`name=${element.name}`);
      if (element.id) partes.push(`id=${element.id}`);
      const classe = typeof element.className === 'string' ? element.className.trim() : '';
      if (classe) partes.push(`class="${classe.slice(0, 80)}"`);
      if (element.placeholder) partes.push(`placeholder="${mascarar(element.placeholder)}"`);
      const papel = element.getAttribute?.('role');
      if (papel) partes.push(`role=${papel}`);
      const rotulo = element.getAttribute?.('aria-label');
      // dentro de linha o aria-label costuma citar o paciente: so o fato de existir
      if (rotulo) partes.push(emLinha(element) ? 'tem-aria-label' : `aria-label="${mascarar(rotulo)}"`);
      return partes.join(' ');
    };

    const campos = [...document.querySelectorAll('input, select, textarea')]
      .filter((element) => element.type !== 'hidden' && !emLinha(element))
      .map((element) => {
        const extras = [];
        if (element.tagName === 'SELECT') {
          extras.push('opcoes=[' + [...element.options].map((o) => mascarar(o.text)).join(' | ') + ']');
          if (element.value) extras.push('valor="' + mascarar(element.value) + '"');
        }
        if (!visivel(element)) extras.push('OCULTO');
        return [descrever(element), ...extras].join(' ');
      });

    const clicaveis = [...document.querySelectorAll('button, a, [role="button"], [role="tab"]')]
      .filter((element) => visivel(element) && !emLinha(element))
      .map((element) => ({ descricao: descrever(element), texto: textoSeguro(element) }))
      .slice(0, 80);

    const desabilitado = (element) =>
      element.disabled === true ||
      element.getAttribute('aria-disabled') === 'true' ||
      (typeof element.className === 'string' ? element.className : '').split(/\s+/).includes('disabled');

    const paginacao = [...document.querySelectorAll('button, a, [role="button"]')]
      .filter((element) => visivel(element) && !emLinha(element))
      .filter((element) => {
        const alvo = `${element.innerText || ''} ${element.getAttribute('aria-label') || ''} ${
          typeof element.className === 'string' ? element.className : ''
        }`.toLowerCase();
        return (
          /next|prev|prox|próx|anterior|seguinte|pagina|page/.test(alvo) ||
          /^\d{1,3}$/.test((element.innerText || '').trim())
        );
      })
      .map((element) => ({
        descricao: descrever(element),
        texto: textoSeguro(element),
        desabilitado: desabilitado(element),
      }))
      .slice(0, 25);

    const tabelas = [...document.querySelectorAll('table')].map((tabela) => ({
      descricao: descrever(tabela),
      colunas: [...tabela.querySelectorAll('thead th, thead td')].map((celula) => (celula.innerText || '').trim()),
      linhas: tabela.querySelectorAll('tbody tr').length,
      colunasPorLinha: tabela.querySelector('tbody tr')?.querySelectorAll('td').length || 0,
    }));

    // a frase de contagem preserva os números: são agregados, não dado pessoal
    const corpo = (document.body?.innerText || '').replace(/\s+/g, ' ');
    const contagem = corpo.match(/Mostrando\s+\d+\s+a\s+\d+\s+de\s+\d+\s+resultados?/i);

    return {
      url: location.href,
      titulo: document.title,
      textoContagem: contagem ? contagem[0] : '',
      campos,
      clicaveis,
      paginacao,
      tabelas,
    };
  });
}
