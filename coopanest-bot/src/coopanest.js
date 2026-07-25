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

async function isLoggedIn(page, selectors) {
  if (!selectors.loggedIn) return false;
  try {
    return (await page.locator(selectors.loggedIn).count()) > 0;
  } catch {
    return false;
  }
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
      .find((input) => visivel(input) && ['text', 'email', 'tel', ''].includes((input.type || '').toLowerCase()));

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

async function performLogin(page, cfg) {
  const { loginUrl, username, password, selectors, navigationTimeoutMs } = cfg.coopanest;
  if (!loginUrl) throw new Error('COOPANEST_LOGIN_URL nao configurada');
  if (!username || !password) throw new Error('COOPANEST_USER / COOPANEST_PASS nao configurados');

  log('abrindo tela de login');
  await page.goto(loginUrl, { waitUntil: 'domcontentloaded', timeout: navigationTimeoutMs });
  await page.waitForLoadState('networkidle', { timeout: navigationTimeoutMs }).catch(() => {});

  if (await isLoggedIn(page, selectors)) {
    log('sessao anterior ainda valida');
    return;
  }

  let userField = await visibleLocator(page, selectors.username);
  let passField = await visibleLocator(page, selectors.password);
  let submitButton = await visibleLocator(page, selectors.submit);

  // seletores do config não bateram: acha o formulário pelo campo de senha
  if (!userField || !passField) {
    const detected = await autoDetectLoginForm(page);
    if (!detected) {
      throw new Error(
        `nao achei o formulario de login em ${page.url()} — rode "npm run scrape" para ver a pagina e ajuste coopanest.selectors no config.json`,
      );
    }
    log(`seletores do config nao bateram; usei o formulario detectado na pagina (${detected.campos} campo(s))`);
    passField = page.locator('[data-coopanest="senha"]').first();
    if (detected.usuario) userField = page.locator('[data-coopanest="usuario"]').first();
    if (detected.enviar) submitButton = page.locator('[data-coopanest="enviar"]').first();
  }

  if (!userField) throw new Error('achei o campo de senha mas nao o de usuario — ajuste coopanest.selectors.username');

  await userField.fill(username);
  await passField.fill(password);

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

  if (selectors.loggedIn && !(await isLoggedIn(page, selectors))) {
    throw new Error(
      `login aparentemente falhou (parei em ${page.url()}) — confira usuario/senha e os seletores no config.json`,
    );
  }
  log('login concluido');
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

    log(`varredura terminou: ${visited.length} URL(s) visitada(s), ${pages.length} pagina(s) com conteudo`);
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }

  if (debug) return { cases: [], warnings, pages, visited };

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
  };
}
