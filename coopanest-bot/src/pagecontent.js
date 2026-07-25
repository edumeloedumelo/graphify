/**
 * Leitura do conteúdo de uma página: usada tanto pelo crawler quanto pela
 * varredura de listagem. Fica em módulo próprio para os dois não se importarem
 * mutuamente.
 */
/** Assinatura do conteúdo, para não reprocessar a mesma tabela vinda de duas URLs. */
export function contentFingerprint(content) {
  return String(content || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 3000);
}

/** Serializa a página: tabelas como linhas "célula | célula" + texto visível. */
export async function extractPageContent(page) {
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
