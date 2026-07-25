import 'dotenv/config';

import { scrapeCases } from '../src/coopanest.js';
import { looksLikeData } from '../src/crawler.js';
import { getConfig } from '../src/config.js';

/**
 * Mostra tudo que o navegador enxerga no portal, sem gastar chamada de IA nem
 * escrever na planilha. Use para ajustar os seletores e os limites do config.json.
 *
 *   node scripts/scrape-debug.js            resumo das páginas
 *   node scripts/scrape-debug.js --full     imprime o conteúdo de cada página
 */
const full = process.argv.includes('--full');
const { pages, visited, warnings } = await scrapeCases({ debug: true });
const keywords = getConfig().crawl?.dataKeywords || [];

console.log(`\n${visited.length} URL(s) visitada(s), ${pages.length} com conteúdo próprio\n`);

for (const page of pages) {
  const comDado = looksLikeData(page.content, { keywords });
  console.log(`${comDado ? '[DADO]' : '[    ]'} ${page.url}  (${page.content.length} caracteres)`);
  if (full) {
    console.log('─'.repeat(70));
    console.log(page.content.slice(0, 4000));
    console.log('─'.repeat(70), '\n');
  }
}

console.log('\n[DADO] = página que seria enviada para a IA.');
console.log('Se uma página de cirurgias não estiver marcada, ajuste crawl.dataKeywords no config.json.\n');

if (warnings.length) console.log('AVISOS:\n' + warnings.map((warning) => `  • ${warning}`).join('\n'));

const naoVisitadas = visited.length === 0;
if (naoVisitadas) console.log('Nenhuma URL visitada — confira COOPANEST_LOGIN_URL e os seletores de login.');
