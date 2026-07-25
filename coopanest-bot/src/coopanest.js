import fs from 'node:fs';
import path from 'node:path';

import { getConfig, STATE_DIR } from './config.js';
import { extractCases, dedupeCases } from './extractor.js';
import { crawlSite, looksLikeData, normalizeUrl } from './crawler.js';

const SESSION_FILE = path.join(STATE_DIR, 'coopanest-session.json');

function log(...args) {
  console.log('[coopanest]', ...args);
}

async function loadPlaywright() {
  try {
    const mod = await import('playwright');
    return mod.chromium;
  } catch (err) {
    throw new Error(
      `Playwright indisponivel (${err.message}). No Railway isso vem do Dockerfile: "npx playwright install --with-deps chromium".`,
    );
  }
}

function readSession() {
  try {
    return JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
  } catch {
    return null;
  }
}

function saveSession(state) {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(SESSION_FILE, JSON.stringify(state));
  } catch (err) {
    console.error('[coopanest] nao consegui salvar a sessao:', err.message);
  }
}

/**
 * Está logado? Dois sinais, porque o seletor configurado é um chute:
 * 1. o seletor de "área logada" (link Sair, por exemplo) aparece na página; ou
 * 2. não há mais campo de senha visível — sinal de que saímos da tela de login.
 * O segundo evita o falso negativo de um portal cujo link de sair não bate com o seletor.
 */
async function looksLoggedIn(page, selectors) {
  if (selectors.loggedIn) {
    try {
      if ((await page.locator(selectors.loggedIn).count()) > 0) return true;
    } catch {
      // seletor inválido para esta página: cai no segundo sinal
    }
  }
  return !(await visibleLocator(page, 'input[type="password"]'));
}

/**
 * Título, texto e a estrutura do formulário — para o erro dizer o que o portal
 * respondeu e quais campos existem de verdade. Nunca inclui valores digitados.
 */
async function pageSnapshot(page) {
  try {
    const info = await page.evaluate(() => {
      const campos = [...document.querySelectorAll('input, select, textarea')]
        .filter((element) => element.type !== 'hidden')
        .map((element) => {
          const partes = [element.tagName.toLowerCase()];
          if (element.type) partes.push(`type=${element.type}`);
          if (element.name) partes.push(`name=${element.name}`);
          if (element.id) partes.push(`id=${element.id}`);
          if (element.placeholder) partes.push(`placeholder="${element.placeholder}"`);
          if (element.tagName === 'SELECT') {
            partes.push(`opcoes=[${[...element.options].map((o) => o.text.trim()).join('|')}]`);
          }
          if (element.type === 'radio' || element.type === 'checkbox') {
            partes.push(`valor=${element.value}`, element.checked ? 'MARCADO' : 'desmarcado');
          }
          if (element.offsetParent === null) partes.push('OCULTO');
          return partes.join(' ');
        });

      const botoes = [...document.querySelectorAll('button, input[type=submit], [role=button]')]
        .map((element) => (element.innerText || element.value || '').trim())
        .filter(Boolean);

      return {
        titulo: document.title || '',
        texto: (document.body?.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 300),
        campos,
        botoes,
      };
    });
    return { url: page.url(), ...info };
  } catch {
    return { url: page.url(), titulo: '', texto: '', campos: [], botoes: [] };
  }
}

/**
 * Preenche um campo e confere se o valor grudou. Alguns portais em React
 * ignoram o preenchimento programático — nesses, digita tecla a tecla.
 */
async function fillField(locator, value) {
  await locator.fill(value).catch(() => {});
  if ((await locator.inputValue().catch(() => '')) === value) return true;

  await locator.click({ timeout: 5000 }).catch(() => {});
  await locator.pressSequentially(String(value), { delay: 40 }).catch(() => {});
  return (await locator.inputValue().catch(() => '')) === value;
}

/** Devolve o primeiro elemento visível do seletor, ou null se não existir. */
async function visibleLocator(page, selector) {
  if (!selector) return null;
  try {
    const locator = page.locator(selector).first();
    if ((await locator.count()) === 0) return null;
    if (!(await locator.isVisible())) return null;
    return locator;
  } catch {
    return null;
  }
}

/**
 * Acha o formulário de login sozinho, quando os seletores do config não batem.
 * Âncora: o campo de senha visível. O usuário é o input de texto logo antes dele,
 * no mesmo formulário. Marca os elementos para o Playwright poder preenchê-los.
 */
async function autoDetectLoginForm(page) {
  return page.evaluate(() => {
    const visivel = (element) => element && element.offsetParent !== null && !element.disabled;

    const senha = [...document.querySelectorAll('input[type="password"]')].find(visivel);
    if (!senha) return null;

    const form = senha.form || document.body;
    const inputs = [...form.querySelectorAll('input')];
    const indice = inputs.indexOf(senha);

    const usuario = inputs
      .slice(0, indice === -1 ? inputs.length : indice)
      .reverse()
      .find(
        (input) =>
          visivel(input) && ['text', 'email', 'tel', 'number', 'search', ''].includes((input.type || '').toLowerCase()),
      );

    const enviar =
      form.querySelector('button[type="submit"], input[type="submit"]') ||
      [...form.querySelectorAll('button, a')].find((element) =>
        /entrar|acessar|login|conectar|enviar/i.test(element.innerText || element.value || ''),
      );

    senha.setAttribute('data-coopanest', 'senha');
    if (usuario) usuario.setAttribute('data-coopanest', 'usuario');
    if (enviar) enviar.setAttribute('data-coopanest', 'enviar');

    return { usuario: Boolean(usuario), enviar: Boolean(enviar), campos: inputs.length };
  });
}

/**
 * Marca o tipo de usuário antes de logar (o portal da Coopanest pede
 * "Cooperado" ou "Administrador"). Cobre rádio, select e aba/botão clicável.
 */
async function selectUserType(page, label) {
  if (!label) return null;
  const alvo = String(label).toLowerCase().trim();

  const achado = await page.evaluate((termo) => {
    const textoDe = (element) => {
      const rotuloPor = element.id ? document.querySelector(`label[for="${CSS.escape(element.id)}"]`) : null;
      const rotuloPai = element.closest('label');
      return `${element.value || ''} ${rotuloPor?.innerText || ''} ${rotuloPai?.innerText || ''}`.toLowerCase();
    };

    const radio = [...document.querySelectorAll('input[type="radio"]')].find((item) =>
      textoDe(item).includes(termo),
    );
    if (radio) {
      radio.setAttribute('data-coopanest', 'tipo');
      return { via: 'radio', jaMarcado: radio.checked };
    }

    for (const select of document.querySelectorAll('select')) {
      const opcao = [...select.options].find((item) =>
        `${item.text} ${item.value}`.toLowerCase().includes(termo),
      );
      if (opcao) {
        select.value = opcao.value;
        select.dispatchEvent(new Event('change', { bubbles: true }));
        return { via: 'select' };
      }
    }

    const clicavel = [...document.querySelectorAll('button, a, [role="tab"], li, div')].find(
      (item) => (item.innerText || '').trim().toLowerCase() === termo && item.offsetParent !== null,
    );
    if (clicavel) {
      clicavel.setAttribute('data-coopanest', 'tipo');
      return { via: 'clique' };
    }

    return null;
  }, alvo);

  if (!achado) return null;
  if (achado.via !== 'select') {
    // clique de verdade: frameworks precisam dos eventos, não basta marcar o checked
    await page.locator('[data-coopanest="tipo"]').first().click({ timeout: 5000 }).catch(() => {});
  }
  return achado;
}

async function performLogin(page, cfg) {
  const { loginUrl, username, password, selectors, navigationTimeoutMs } = cfg.coopanest;
  if (!loginUrl) throw new Error('COOPANEST_LOGIN_URL nao configurada');
  if (!username || !password) throw new Error('COOPANEST_USER / COOPANEST_PASS nao configurados');

  log('abrindo tela de login');
  await page.goto(loginUrl, { waitUntil: 'domcontentloaded', timeout: navigationTimeoutMs });
  await page.waitForLoadState('networkidle', { timeout: navigationTimeoutMs }).catch(() => {});

  if (await looksLoggedIn(page, selectors)) {
    log('sessao anterior ainda valida');
    return;
  }

  const tipoUsuario = cfg.coopanest.userType || 'Cooperado';
  const tipoMarcado = await selectUserType(page, tipoUsuario);
  if (tipoMarcado) log(`tipo de usuario "${tipoUsuario}" marcado (via ${tipoMarcado.via})`);
  else log(`nao achei a opcao de tipo de usuario "${tipoUsuario}" — seguindo sem marcar`);

  let userField = await visibleLocator(page, selectors.username);
  let passField = await visibleLocator(page, selectors.password);
  let submitButton = await visibleLocator(page, selectors.submit);
  let usuarioDetectado = userField ? 'seletor do config' : '';

  // seletores do config não bateram: acha o formulário pelo campo de senha
  if (!userField || !passField) {
    const detected = await autoDetectLoginForm(page);
    if (!detected) {
      throw new Error(
        `nao achei o formulario de login em ${page.url()} — rode "npm run scrape" para ver a pagina e ajuste coopanest.selectors no config.json`,
      );
    }
    log(`seletores do config nao bateram; usei o formulario detectado na pagina (${detected.campos} campo(s))`);
    usuarioDetectado = `autodeteccao (${detected.campos} campos no form)`;
    passField = page.locator('[data-coopanest="senha"]').first();
    if (detected.usuario) userField = page.locator('[data-coopanest="usuario"]').first();
    if (detected.enviar) submitButton = page.locator('[data-coopanest="enviar"]').first();
  }

  if (!userField) throw new Error('achei o campo de senha mas nao o de usuario — ajuste coopanest.selectors.username');

  const usuarioOk = await fillField(userField, username);
  const senhaOk = await fillField(passField, password);
  if (!usuarioOk || !senhaOk) {
    log(`atencao: campo ${!usuarioOk ? 'usuario' : 'senha'} nao aceitou o valor digitado`);
  }

  const urlAntes = page.url();
  await Promise.all([
    page.waitForLoadState('networkidle', { timeout: navigationTimeoutMs }).catch(() => {}),
    submitButton ? submitButton.click() : passField.press('Enter'),
  ]);
  await page.waitForTimeout(2500);

  // O Chromium só envia no Enter quando o formulário tem um campo só: com usuário
  // e senha, nada acontece. Sem botão identificável, dispara o submit na mão.
  if (!submitButton && page.url() === urlAntes && (await visibleLocator(page, 'input[type="password"]'))) {
    log('Enter nao enviou o formulario; disparando submit direto');
    await page.evaluate(() => {
      const form = document.querySelector('input[type="password"]')?.form;
      if (!form) return;
      if (typeof form.requestSubmit === 'function') form.requestSubmit();
      else form.submit();
    });
    await page.waitForLoadState('networkidle', { timeout: navigationTimeoutMs }).catch(() => {});
    await page.waitForTimeout(2000);
  }

  if (!(await looksLoggedIn(page, selectors))) {
    const snap = await pageSnapshot(page);
    throw new Error(
      `login nao confirmado em ${snap.url} (titulo: "${snap.titulo}"). ` +
        `A pagina diz: "${snap.texto}" || TIPO DE USUARIO: ${
          tipoMarcado ? `"${tipoUsuario}" marcado via ${tipoMarcado.via}` : `"${tipoUsuario}" NAO encontrado`
        } || CAMPO USUARIO: ${usuarioDetectado} || VALORES ACEITOS: usuario=${usuarioOk}, senha=${senhaOk}` +
        ` || CAMPOS DA PAGINA: ${snap.campos.join(' ;; ')} || BOTOES: ${snap.botoes.join(' | ')}`,
    );
  }
  log(`login confirmado (${page.url()})`);
}

/** URLs semente: as configuradas ou, na falta delas, a página em que o login caiu. */
function seedUrls(cfg, page) {
  const configured = String(cfg.coopanest?.casesUrl || '')
    .split(',')
    .map((url) => url.trim())
    .filter(Boolean)
    .map(normalizeUrl)
    .filter(Boolean);

  return configured.length ? configured : [normalizeUrl(page.url())].filter(Boolean);
}

/**
 * Loga no portal da Coopanest Rio, varre TODAS as páginas alcançáveis a partir
 * das sementes e devolve as cirurgias estruturadas.
 *
 * @param {{debug?: boolean}} options debug: devolve o conteúdo cru, sem chamar a IA
 */
export async function scrapeCases({ debug = false } = {}) {
  const cfg = getConfig();
  const chromium = await loadPlaywright();
  const timeout = cfg.coopanest.navigationTimeoutMs || 45_000;

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
    // CHROMIUM_PATH: usar um binario ja instalado no host em vez do baixado pelo Playwright
    ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
  });

  const context = await browser.newContext({
    storageState: readSession() || undefined,
    viewport: { width: 1440, height: 900 },
    locale: 'pt-BR',
  });
  context.setDefaultTimeout(timeout);

  let pages = [];
  const warnings = [];
  let visited = [];
  let diagnosticoLinks = {};

  try {
    const page = await context.newPage();
    await performLogin(page, cfg);
    saveSession(await context.storageState());

    const seeds = seedUrls(cfg, page);
    log(`varrendo o portal a partir de ${seeds.length} URL(s) semente`);

    const result = await crawlSite(page, seeds, { log: (line) => log(line) });
    pages = result.pages;
    visited = result.visited;
    warnings.push(...result.warnings);
    diagnosticoLinks = {
      totalLinks: result.totalLinks,
      linksEncontrados: result.linksEncontrados,
      linksIgnorados: result.linksIgnorados,
    };

    log(`varredura terminou: ${visited.length} URL(s) visitada(s), ${pages.length} pagina(s) com conteudo`);
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }

  if (debug) return { cases: [], warnings, pages, visited, ...diagnosticoLinks };

  // só as páginas que parecem ter dados vão para a IA
  const keywords = cfg.crawl?.dataKeywords || [];
  const withData = cfg.crawl?.onlyPagesWithData === false
    ? pages
    : pages.filter((item) => looksLikeData(item.content, { keywords, minMatches: cfg.crawl?.minKeywordMatches ?? 2 }));

  const skipped = pages.length - withData.length;
  if (skipped > 0) log(`${skipped} pagina(s) sem cara de dado — nao gastei IA com elas`);

  const collected = [];
  for (const item of withData) {
    const result = await extractCases({ label: item.url, content: item.content });
    if (result.cases.length) log(`${result.cases.length} cirurgia(s) em ${item.url}`);
    collected.push(...result.cases);
    warnings.push(...result.warnings);
  }

  return {
    cases: dedupeCases(collected),
    warnings,
    pages: pages.map((item) => item.url),
    visited,
    pagesAnalyzed: withData.length,
    ...diagnosticoLinks,
  };
}
