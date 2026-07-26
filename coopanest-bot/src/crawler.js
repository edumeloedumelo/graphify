import { getConfig } from './config.js';
import { extractPageContent, contentFingerprint } from './pagecontent.js';
import { sweepListing, pareceListagem } from './sweep.js';

function envNumber(name) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= 0 ? value : undefined;
}

/** Tira o fragmento e normaliza a barra final — a query fica (paginação depende dela). */
export function normalizeUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    url.hash = '';
    if (url.pathname.length > 1 && url.pathname.endsWith('/')) url.pathname = url.pathname.slice(0, -1);
    return url.toString();
  } catch {
    return '';
  }
}

export function sameOrigin(a, b) {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
}

/**
 * Decide se um link entra na fila.
 * O logout é o link mais perigoso do portal: clicar nele derruba a sessão no meio da varredura.
 */
export function motivoIgnorar(url, { origin, skipPatterns = [], sameOriginOnly = true } = {}) {
  const normalized = normalizeUrl(url);
  if (!normalized) return 'nao e uma URL';
  if (!/^https?:/i.test(normalized)) return 'nao e http(s)';
  if (sameOriginOnly && origin && !sameOrigin(normalized, origin)) return 'outro dominio';

  const lower = normalized.toLowerCase();
  const bloqueio = skipPatterns.find((pattern) => {
    try {
      return new RegExp(pattern, 'i').test(lower);
    } catch {
      return lower.includes(pattern.toLowerCase());
    }
  });
  return bloqueio ? `bloqueado por "${bloqueio}"` : null;
}

export function shouldVisit(url, { origin, skipPatterns = [], visited = new Set(), sameOriginOnly = true }) {
  const normalized = normalizeUrl(url);
  if (!normalized) return false;
  if (visited.has(normalized)) return false;
  return motivoIgnorar(normalized, { origin, skipPatterns, sameOriginOnly }) === null;
}

/** A página parece ter dados de cirurgia? Evita gastar IA com menu, ajuda e afins. */
export function looksLikeData(content, { keywords = [], minMatches = 2 } = {}) {
  if (!content || content.length < 40) return false;

  const lower = content.toLowerCase();
  const hits = keywords.filter((keyword) => lower.includes(String(keyword).toLowerCase())).length;
  if (hits === 0) return false;

  // o menu do portal se repete em toda página, então palavra-chave sozinha não
  // basta: uma listagem de cirurgia sempre traz data ou valor
  const hasDate = /\d{1,2}\/\d{1,2}\/\d{2,4}/.test(content);
  const hasMoney = /\d{1,3}(?:\.\d{3})*,\d{2}/.test(content);
  if (!hasDate && !hasMoney) return false;

  return hits >= (content.startsWith('TABELAS:') ? 1 : minMatches);
}

async function collectLinks(page) {
  try {
    return await page.$$eval('a[href]', (anchors) =>
      anchors
        .map((anchor) => ({ href: anchor.href, text: (anchor.innerText || '').trim().slice(0, 80) }))
        .filter((link) => link.href),
    );
  } catch {
    return [];
  }
}

/** Procura o botão/link de "próxima página" que ainda esteja clicável. */
async function findNextControl(page, selectors = []) {
  for (const selector of selectors) {
    try {
      const locator = page.locator(selector).first();
      if ((await locator.count()) === 0) continue;
      if (!(await locator.isVisible())) continue;
      if (!(await locator.isEnabled())) continue;
      const disabled = await locator.evaluate((element) => {
        // "disabled:opacity-75" do Tailwind nao e estado desabilitado
        const classes = (typeof element.className === 'string' ? element.className : '').split(/\s+/);
        return (
          element.disabled === true ||
          element.getAttribute('aria-disabled') === 'true' ||
          classes.includes('disabled') ||
          element.closest('[disabled], [aria-disabled="true"]') !== null
        );
      });
      if (disabled) continue;
      return locator;
    } catch {
      // seletor inválido para esta página: tenta o próximo
    }
  }
  return null;
}

async function settle(page, timeout, waitMs, crawl = {}) {
  await page.waitForLoadState('networkidle', { timeout }).catch(() => {});
  if (waitMs > 0) await page.waitForTimeout(waitMs);

  // Em SPA a tabela costuma ser renderizada depois do networkidle: espera ela
  // aparecer em vez de fotografar a tela ainda vazia.
  const seletores = (crawl.contentSelectors || []).join(', ');
  if (seletores) {
    await page
      .locator(seletores)
      .first()
      .waitFor({ state: 'visible', timeout: crawl.contentTimeoutMs ?? 8000 })
      .catch(() => {});
  }
}

/**
 * Lê uma página e as seguintes, clicando na paginação enquanto houver.
 * Para quando o conteúdo repete — sinal de que o clique não avançou.
 */
async function readWithPagination(page, url, { crawl, timeout, onPage }) {
  const results = [];
  const links = [];
  const seenHere = new Set();
  let clicks = 0;

  for (;;) {
    const content = await extractPageContent(page);
    const fingerprint = contentFingerprint(content);

    if (seenHere.has(fingerprint)) break;
    seenHere.add(fingerprint);

    const label = clicks === 0 ? url : `${url} (página ${clicks + 1})`;
    results.push({ url: label, content });
    onPage?.(label, content);

    // os links precisam sair de CADA página da paginação: clicar em "próxima"
    // troca o conteúdo, e os detalhes da página anterior sumiriam da fila
    links.push(...(await collectLinks(page)));

    if (clicks >= (crawl.maxPaginationClicks ?? 20)) break;

    const next = await findNextControl(page, crawl.nextPageSelectors || []);
    if (!next) break;

    try {
      await next.click({ timeout: 10_000 });
      clicks += 1;
      await settle(page, timeout, crawl.waitAfterLoadMs ?? 800, crawl);
    } catch {
      break;
    }
  }

  return { results, links };
}

/**
 * Varre o portal inteiro a partir das URLs semente: segue os links do mesmo
 * domínio em largura, respeitando maxPages/maxDepth, e pagina cada listagem.
 *
 * @param {import('playwright').Page} page
 * @param {string[]} seeds
 * @returns {Promise<Array<{url:string, content:string, depth:number}>>}
 */
export async function crawlSite(page, seeds, { onPage, log = () => {} } = {}) {
  const cfg = getConfig();
  const crawl = cfg.crawl || {};
  const timeout = cfg.coopanest?.navigationTimeoutMs || 45_000;

  const maxPages = envNumber('CRAWL_MAX_PAGES') ?? crawl.maxPages ?? 60;
  const maxDepth = envNumber('CRAWL_MAX_DEPTH') ?? crawl.maxDepth ?? 3;
  const skipPatterns = crawl.skipUrlPatterns || [];
  const sameOriginOnly = crawl.sameOriginOnly !== false;

  const origin = seeds.length ? seeds[0] : page.url();
  const visited = new Set();
  const fingerprints = new Set();
  const collected = [];
  const warnings = [];
  const linksVistos = new Set();
  const linksIgnorados = new Map();
  let diagnosticoSweep = null;

  const queue = seeds
    .map((url) => normalizeUrl(url))
    .filter(Boolean)
    .map((url) => ({ url, depth: 0 }));

  while (queue.length > 0 && collected.length < maxPages) {
    const { url, depth } = queue.shift();
    if (visited.has(url)) continue;
    visited.add(url);

    try {
      const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout });
      if (response && response.status() >= 400) {
        warnings.push(`${url} respondeu ${response.status()}`);
        continue;
      }
      await settle(page, timeout, crawl.waitAfterLoadMs ?? 800, crawl);
    } catch (err) {
      warnings.push(`falha abrindo ${url}: ${err.message}`);
      continue;
    }

    // a sessão caiu? o portal costuma jogar de volta para o login
    const landed = normalizeUrl(page.url());
    if (crawl.loginUrlPattern && new RegExp(crawl.loginUrlPattern, 'i').test(landed) && depth > 0) {
      warnings.push(`sessão expirou ao abrir ${url} (voltou para o login)`);
      continue;
    }

    let pagesHere = [];
    let links = [];
    if (cfg.sweep?.ativo !== false && (await pareceListagem(page, cfg))) {
      // tela de listagem com filtros: varre periodo, filtros e todas as paginas
      const sweep = await sweepListing(page, { cfg, log, onPage });
      pagesHere = sweep.paginas;
      warnings.push(...sweep.avisos);
      diagnosticoSweep = sweep.diagnostico;
      links = await collectLinks(page);
    } else {
      ({ results: pagesHere, links } = await readWithPagination(page, url, { crawl, timeout, onPage }));
    }
    for (const item of pagesHere) {
      const fingerprint = contentFingerprint(item.content);
      if (fingerprints.has(fingerprint)) continue;
      fingerprints.add(fingerprint);
      collected.push({ ...item, depth });
      if (collected.length >= maxPages) break;
    }

    log(`[${collected.length}/${maxPages}] ${url} (profundidade ${depth})`);

    if (depth >= maxDepth) continue;

    for (const link of links) {
      const normalized = normalizeUrl(link.href);
      if (normalized) linksVistos.add(normalized);

      const motivo = motivoIgnorar(normalized || link.href, { origin, skipPatterns, sameOriginOnly });
      if (motivo) {
        linksIgnorados.set(normalized || link.href, motivo);
        continue;
      }
      if (visited.has(normalized) || queue.some((item) => item.url === normalized)) continue;
      queue.push({ url: normalized, depth: depth + 1 });
    }
  }

  if (queue.length > 0) {
    warnings.push(`limite de ${maxPages} páginas atingido; ${queue.length} link(s) ficaram de fora`);
  }

  return {
    pages: collected,
    warnings,
    visited: [...visited],
    // diagnostico: o que existe de link na pagina e por que cada um ficou de fora
    linksEncontrados: [...linksVistos].slice(0, 25),
    totalLinks: linksVistos.size,
    linksIgnorados: [...linksIgnorados.entries()].slice(0, 12).map(([url, motivo]) => `${url} → ${motivo}`),
    sweep: diagnosticoSweep,
  };
}

export { extractPageContent, contentFingerprint };
