import fs from 'node:fs';
import path from 'node:path';

import { getConfig, STATE_DIR } from './config.js';
import { analyzePortalContent, dedupeCases } from './triage.js';

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
      `Playwright indisponivel (${err.message}). No Railway isso vem do Dockerfile: "npx playwright install chromium".`,
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

/** Serializa a pagina: tabelas viradas em linhas "celula | celula" + texto visivel. */
async function extractPageContent(page) {
  return page.evaluate(() => {
    const tables = [...document.querySelectorAll('table')]
      .map((table) => {
        const rows = [...table.querySelectorAll('tr')]
          .map((tr) =>
            [...tr.querySelectorAll('th,td')]
              .map((cell) => (cell.innerText || '').replace(/\s+/g, ' ').trim())
              .join(' | '),
          )
          .filter((row) => row.replace(/[|\s]/g, '').length > 0);
        return rows.join('\n');
      })
      .filter(Boolean)
      .join('\n\n---\n\n');

    const bodyText = (document.body?.innerText || '').replace(/\n{3,}/g, '\n\n').trim();
    return tables ? `TABELAS:\n${tables}\n\nTEXTO DA PAGINA:\n${bodyText}` : bodyText;
  });
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
    log('sessao ainda valida, login dispensado');
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
    const url = page.url();
    throw new Error(`login aparentemente falhou (continuo em ${url}) — confira usuario/senha e os seletores no config.json`);
  }
  log('login concluido');
}

function casesUrls(cfg) {
  const raw = cfg.coopanest?.casesUrl || '';
  const urls = String(raw)
    .split(',')
    .map((url) => url.trim())
    .filter(Boolean);
  return urls;
}

/**
 * Faz login no portal da Coopanest Rio, varre as paginas de cirurgias e devolve
 * os casos estruturados. As credenciais sao as do proprio usuario do bot.
 */
export async function scrapeCases({ debug = false } = {}) {
  const cfg = getConfig();
  const chromium = await loadPlaywright();
  const selectors = cfg.coopanest.selectors || {};
  const timeout = cfg.coopanest.navigationTimeoutMs || 45_000;

  const warnings = [];
  const pages = [];

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

  try {
    const page = await context.newPage();
    await performLogin(page, cfg);
    saveSession(await context.storageState());

    const urls = casesUrls(cfg);
    if (urls.length === 0) {
      // sem URL especifica, usa a pagina em que o login caiu
      urls.push(page.url());
      warnings.push('COOPANEST_CASES_URL vazia — usei a pagina inicial pos-login');
    }

    for (const url of urls) {
      try {
        log('lendo', url);
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout });
        await page.waitForLoadState('networkidle', { timeout }).catch(() => {});
        if (selectors.casesTable) {
          await page.locator(selectors.casesTable).first().waitFor({ timeout: 10_000 }).catch(() => {});
        }
        const content = await extractPageContent(page);
        pages.push({ url, content });
      } catch (err) {
        warnings.push(`falha abrindo ${url}: ${err.message}`);
      }
    }
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }

  if (debug) return { cases: [], warnings, pages };

  const collected = [];
  for (const { url, content } of pages) {
    if (!content || content.length < 40) {
      warnings.push(`pagina ${url} veio praticamente vazia`);
      continue;
    }
    const result = await analyzePortalContent({ label: url, content });
    collected.push(...result.cases);
    warnings.push(...result.warnings);
  }

  return { cases: dedupeCases(collected), warnings, pages: pages.map((page) => page.url) };
}
