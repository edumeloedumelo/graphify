import { getConfig } from './config.js';
import { normalize, toNumber, monthKey } from './format.js';

/** O caso conta para a Sara? Procura os parceiros configurados em varios campos. */
export function isSalaryCase(item, cfg = getConfig()) {
  const partners = (cfg.salary?.partners || []).map(normalize).filter(Boolean);
  if (partners.length === 0) return false;

  const haystack = normalize(
    [item.parceiro, item.medico, item.hospital, item.procedimento, item.observacoes, item.convenio]
      .filter(Boolean)
      .join(' '),
  );
  if (!haystack) return false;

  return partners.some((partner) => haystack.includes(partner));
}

/**
 * Salario da Sara: 5% do liquido (bruto - 20% de imposto) das cirurgias
 * ligadas aos parceiros configurados, agrupado por mes.
 */
export function computeSalary(cases = [], cfg = getConfig()) {
  const taxRate = cfg.salary?.taxRate ?? 0.2;
  const percentage = cfg.salary?.percentage ?? 0.05;

  const byMonth = new Map();
  const matched = [];

  for (const item of cases) {
    if (!isSalaryCase(item, cfg)) continue;

    const gross = toNumber(item.valorBruto) || 0;
    if (gross <= 0) {
      matched.push({ ...item, gross: 0, net: 0, share: 0, skipped: 'sem valor bruto' });
      continue;
    }

    const net = gross * (1 - taxRate);
    const share = net * percentage;
    const month = monthKey(item.data) || 'sem data';

    const bucket = byMonth.get(month) || { month, count: 0, gross: 0, tax: 0, net: 0, salary: 0, cases: [] };
    bucket.count += 1;
    bucket.gross += gross;
    bucket.tax += gross * taxRate;
    bucket.net += net;
    bucket.salary += share;
    bucket.cases.push({ paciente: item.paciente, data: item.data, parceiro: item.parceiro, gross, share });
    byMonth.set(month, bucket);

    matched.push({ ...item, gross, net, share });
  }

  const months = [...byMonth.values()].sort((a, b) => compareMonths(a.month, b.month));
  const totals = months.reduce(
    (acc, bucket) => ({
      count: acc.count + bucket.count,
      gross: acc.gross + bucket.gross,
      tax: acc.tax + bucket.tax,
      net: acc.net + bucket.net,
      salary: acc.salary + bucket.salary,
    }),
    { count: 0, gross: 0, tax: 0, net: 0, salary: 0 },
  );

  return { months, totals, matched, taxRate, percentage };
}

function compareMonths(a, b) {
  const parse = (value) => {
    const match = String(value).match(/^(\d{2})\/(\d{4})$/);
    return match ? Number(`${match[2]}${match[1]}`) : 0;
  };
  return parse(a) - parse(b);
}
