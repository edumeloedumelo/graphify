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

async function performLogin(page, cfg) {
  const { loginUrl, username, password, selectors, navigationTimeoutMs } = cfg.coopanest;
  if (!loginUrl) throw new Error('COOPANEST_LOGIN_URL nao configurada');
  if (!username || !password) throw new Error('COOPANEST_USER / COOPANEST_PASS nao configurados');

  log('abrindo tela de login');
  await page.goto(loginUrl, { waitUntil: 'domcontentloaded', timeout: navigationTimeoutMs });

  if (await isLoggedIn(page, selectors)) {
    log('sessao anterior ainda valida');
    return;
  }

  await page.locator(selectors.username).first().fill(username);
  await page.locator(selectors.password).first().fill(password);

  await Promise.all([
    page.waitForLoadState('networkidle', { timeout: navigationTimeoutMs }).catch(() => {}),
    page.locator(selectors.submit).first().click(),
  ]);
  await page.waitForTimeout(2500);

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
