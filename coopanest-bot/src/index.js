import 'dotenv/config';
import express from 'express';

import { startScheduler } from './scheduler.js';
import { runSync, isSyncRunning, lastSyncInfo } from './sync.js';
import { loadSnapshot, countCases } from './snapshot.js';
import { computeSalary } from './salary.js';
import { getConfig } from './config.js';
import * as sheets from './sheets.js';
import { inspetorHabilitado, autorizado, motivoRecusarUrl } from './inspectorguard.js';

const app = express();
const PORT = Number(process.env.PORT) || 3000;

app.use(express.json({ limit: '5mb' }));

// resultado da conferência da planilha feita no boot
let sheetsCheck = { ok: false, motivo: 'ainda nao conferido' };

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    bot: getConfig().botName,
    uptimeSeconds: Math.round(process.uptime()),
    casesTracked: countCases(),
    syncRunning: isSyncRunning(),
    lastSync: lastSyncInfo(),
    planilha: sheetsCheck,
    portal: {
      urlConfigurada: Boolean(process.env.COOPANEST_LOGIN_URL),
      credenciais: Boolean(process.env.COOPANEST_USER && process.env.COOPANEST_PASS),
    },
    anthropic: Boolean(process.env.ANTHROPIC_API_KEY),
  });
});

app.get('/status', (_req, res) => {
  res.json({
    lastSync: lastSyncInfo(),
    casesTracked: countCases(),
    syncRunning: isSyncRunning(),
    sheetUrl: sheets.sheetUrl(),
  });
});

app.get('/salario', (_req, res) => {
  const summary = computeSalary(Object.values(loadSnapshot()));
  res.json({
    beneficiario: getConfig().salary?.beneficiary || 'Sara',
    meses: summary.months.map((month) => ({
      mes: month.month,
      cirurgias: month.count,
      bruto: round2(month.gross),
      imposto: round2(month.tax),
      liquido: round2(month.net),
      salario: round2(month.salary),
    })),
    total: round2(summary.totals.salary),
  });
});

/** Dispara uma varredura fora do horário. Responde antes de terminar. */
function dispararSync(req, res, { html = false } = {}) {
  const secret = process.env.SYNC_SECRET;
  if (secret) {
    const provided = req.get('x-sync-secret') || req.query.secret || req.body?.secret;
    if (provided !== secret) {
      return html ? res.status(401).send(pagina('Segredo inválido', '')) : res.status(401).json({ error: 'segredo invalido' });
    }
  }

  const jaRodando = isSyncRunning();
  if (!jaRodando) runSync({ trigger: 'http' }).catch((err) => console.error('[/sync] erro:', err));

  if (!html) {
    return jaRodando
      ? res.status(409).json({ error: 'sincronizacao ja em andamento' })
      : res.status(202).json({ started: true });
  }

  return res.status(jaRodando ? 409 : 202).send(
    pagina(
      jaRodando ? 'Já tem uma varredura rodando' : 'Varredura iniciada',
      jaRodando
        ? 'Aguarde ela terminar antes de disparar outra.'
        : 'Ela roda em segundo plano e leva alguns minutos. Volte aqui depois para ver o resultado.',
    ),
  );
}

/** Página simples, legível no celular. */
function pagina(titulo, texto) {
  const info = lastSyncInfo();
  const linhas = info
    ? [
        `Última varredura: ${info.at || '—'}`,
        info.error ? `Erro: ${info.error}` : `Cirurgias lidas: ${info.casesFound ?? '—'}`,
        info.error ? '' : `Novas: ${info.added ?? 0} · Atualizadas: ${info.updated ?? 0}`,
        info.error ? '' : `Páginas visitadas: ${info.pagesVisited ?? '—'}`,
        (info.warnings || []).length ? `Avisos: ${info.warnings.join(' | ')}` : '',
      ].filter(Boolean)
    : ['Nenhuma varredura registrada ainda.'];

  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>${titulo}</title>
<style>
 body{font-family:-apple-system,system-ui,sans-serif;margin:0;padding:24px;background:#0f172a;color:#e2e8f0;line-height:1.6}
 h1{font-size:20px;margin:0 0 8px}
 p{margin:0 0 20px;color:#94a3b8}
 ul{list-style:none;padding:0;margin:0 0 24px;background:#1e293b;border-radius:12px;padding:16px}
 li{padding:4px 0;font-size:15px;word-break:break-word}
 a{display:block;text-align:center;background:#2563eb;color:#fff;text-decoration:none;padding:14px;border-radius:12px;margin-bottom:10px;font-weight:600}
 a.sec{background:#334155}
</style></head><body>
<h1>${titulo}</h1><p>${texto}</p>
<ul>${linhas.map((l) => `<li>${l}</li>`).join('')}</ul>
<a href="/varredura">Rodar varredura agora</a>
<a class="sec" href="/health">Ver diagnóstico completo</a>
${sheets.sheetUrl() ? `<a class="sec" href="${sheets.sheetUrl()}">Abrir a planilha</a>` : ''}
</body></html>`;
}

// estrutura do DOM do portal — devolve forma, nunca conteudo de linha
app.get('/inspecionar', async (req, res) => {
  if (!inspetorHabilitado()) return res.status(404).json({ error: 'inspetor desativado (INSPECTOR_ENABLED=false)' });

  const permissao = autorizado(req);
  if (!permissao.ok) return res.status(permissao.status).json({ error: permissao.motivo });

  const urls = String(req.query.url || '')
    .split(',')
    .map((url) => url.trim())
    .filter(Boolean);

  for (const url of urls) {
    const recusa = motivoRecusarUrl(url);
    if (recusa) return res.status(403).json({ error: `${url}: ${recusa}` });
  }

  try {
    const { inspectPortal } = await import('./coopanest.js');
    return res.json(await inspectPortal(urls, { abrir: String(req.query.abrir || '') }));
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.post('/sync', (req, res) => dispararSync(req, res));

// versão para abrir no navegador do celular — GET não dá para fazer com POST
app.get('/varredura', (req, res) => dispararSync(req, res, { html: true }));
app.get('/', (_req, res) => res.send(pagina('Coopanest Sync', 'Sincronização do portal com a planilha.')));

app.use((req, res) => res.status(404).json({ error: 'not found', path: req.path }));

function round2(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

app.listen(PORT, '0.0.0.0', async () => {
  console.log(`[index] ${getConfig().botName} ouvindo na porta ${PORT}`);
  console.log('[index] GET /health | GET /status | GET /salario | POST /sync');

  sheetsCheck = await sheets.verifyAccess();
  if (sheetsCheck.ok) {
    console.log(`[index] planilha OK: "${sheetsCheck.planilha}" (abas: ${sheetsCheck.abas.join(', ') || 'nenhuma ainda'})`);
  } else {
    console.error(`[index] PLANILHA INDISPONIVEL: ${sheetsCheck.motivo}`);
  }

  if (!process.env.ANTHROPIC_API_KEY) console.error('[index] ANTHROPIC_API_KEY nao configurada');
  if (!process.env.COOPANEST_USER || !process.env.COOPANEST_PASS) {
    console.error('[index] COOPANEST_USER / COOPANEST_PASS nao configurados');
  }

  startScheduler();
});

process.on('unhandledRejection', (err) => console.error('[index] unhandledRejection:', err));
process.on('uncaughtException', (err) => console.error('[index] uncaughtException:', err));
