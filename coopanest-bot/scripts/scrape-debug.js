import 'dotenv/config';

import { scrapeCases } from '../src/coopanest.js';

/**
 * Mostra o que o navegador enxerga no portal, sem gastar chamada de IA nem
 * escrever na planilha. Use para ajustar os seletores do config.json.
 */
const { pages, warnings } = await scrapeCases({ debug: true });

for (const page of pages) {
  console.log('='.repeat(70));
  console.log(page.url);
  console.log('='.repeat(70));
  console.log(page.content.slice(0, 6000));
  console.log(`\n[${page.content.length} caracteres no total]\n`);
}

if (warnings.length) console.log('AVISOS:', warnings);
