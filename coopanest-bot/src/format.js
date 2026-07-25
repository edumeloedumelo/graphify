/**
 * Converte a saida markdown do Claude para o formato que o WhatsApp entende.
 * WhatsApp usa *negrito*, _italico_, ~riscado~ e ```mono```.
 */
export function toWhatsApp(input) {
  if (!input) return '';
  let text = String(input);

  // blocos de codigo: mantem o conteudo, descarta a cerca
  text = text.replace(/```[a-z]*\n([\s\S]*?)```/gi, (_, body) => body.trimEnd());
  text = text.replace(/```/g, '');

  // titulos markdown viram linha em negrito
  text = text.replace(/^#{1,6}\s*(.+)$/gm, (_, title) => `*${title.trim()}*`);

  // negrito/italico markdown -> negrito do WhatsApp
  text = text.replace(/\*\*\*(.+?)\*\*\*/gs, '*$1*');
  text = text.replace(/\*\*(.+?)\*\*/gs, '*$1*');
  text = text.replace(/__(.+?)__/gs, '*$1*');

  // italico com underscore isolado -> _italico_ (ja e o formato do WhatsApp)
  text = text.replace(/(^|\s)_([^_\n]+)_(?=\s|$|[.,;:!?])/g, '$1_$2_');

  // listas
  text = text.replace(/^\s*[-*+]\s+/gm, '• ');
  text = text.replace(/^\s*(\d+)\.\s+/gm, '$1. ');

  // linhas horizontais
  text = text.replace(/^\s*([-*_])\1{2,}\s*$/gm, '——————');

  // links markdown -> "texto (url)"
  text = text.replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, '$1 ($2)');

  // tabelas markdown: remove separadores e limpa pipes das bordas
  text = text.replace(/^\s*\|?[\s:|-]*\|[\s:|-]*\|?\s*$/gm, (line) =>
    /-{3,}/.test(line) ? '' : line,
  );
  text = text.replace(/^\s*\|(.+)\|\s*$/gm, (_, row) =>
    row
      .split('|')
      .map((cell) => cell.trim())
      .filter(Boolean)
      .join(' | '),
  );

  // colapsa excesso de linhas em branco
  text = text.replace(/\n{3,}/g, '\n\n');

  return text.trim();
}

export function formatMoney(value) {
  const num = toNumber(value);
  if (num === null) return '';
  return num.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function formatBRL(value) {
  const formatted = formatMoney(value);
  return formatted ? `R$ ${formatted}` : '';
}

/** Aceita "R$ 1.234,56", "1234.56", 1234.56 — devolve Number ou null. */
export function toNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;

  let text = String(value).trim();
  if (!text) return null;
  text = text.replace(/[^\d,.\-]/g, '');
  if (!text || text === '-') return null;

  const lastComma = text.lastIndexOf(',');
  const lastDot = text.lastIndexOf('.');
  if (lastComma > lastDot) {
    text = text.replace(/\./g, '').replace(',', '.');
  } else if (lastDot > -1) {
    text = text.replace(/,/g, '');
  } else {
    text = text.replace(',', '.');
  }

  const num = Number(text);
  return Number.isFinite(num) ? num : null;
}

/** Normaliza texto para comparacao (sem acento, minusculo, espacos colapsados). */
export function normalize(value) {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/** DD/MM/AAAA a partir de varios formatos comuns. */
export function formatDate(value) {
  if (!value) return '';
  const text = String(value).trim();

  const br = text.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})/);
  if (br) {
    const [, d, m, y] = br;
    const year = y.length === 2 ? `20${y}` : y;
    return `${d.padStart(2, '0')}/${m.padStart(2, '0')}/${year}`;
  }

  const iso = text.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) {
    const [, y, m, d] = iso;
    return `${d}/${m}/${y}`;
  }

  return text;
}

/** "MM/AAAA" a partir de uma data DD/MM/AAAA. */
export function monthKey(value) {
  const date = formatDate(value);
  const match = date.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  return match ? `${match[2]}/${match[3]}` : '';
}

export function nowStamp(timezone = 'America/Sao_Paulo') {
  try {
    return new Intl.DateTimeFormat('pt-BR', {
      timeZone: timezone,
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    }).format(new Date());
  } catch {
    return new Date().toISOString();
  }
}
