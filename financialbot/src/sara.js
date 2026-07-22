// sara.js — cálculo do salário da secretária (Sara).
// Salário = 5% do líquido das cirurgias que ela autoriza.
// Líquido = bruto − 20% de imposto.
// Uma cirurgia "conta" quando o cirurgião está na lista OU a clínica está na lista.

import { getConfig } from './state.js';

function norm(s) {
  return String(s || '').toLowerCase().normalize('NFD').replace(/\p{M}/gu, '').replace(/\s+/g, ' ').trim();
}

const DEFAULT_SARA = {
  commissionRate: 0.05, // 5%
  taxRate: 0.20, // 20% de imposto
  basis: 'faturado', // 'faturado' (valor bruto) ou 'recebido' (valor efetivamente pago)
  surgeons: ['Raphael Datrino', 'Gustavo Siqueira'],
  clinics: ['Clínica Dat Baby'],
};

export function getSaraConfig() {
  const c = getConfig().sara || {};
  return {
    commissionRate: c.commissionRate ?? DEFAULT_SARA.commissionRate,
    taxRate: c.taxRate ?? DEFAULT_SARA.taxRate,
    basis: c.basis ?? DEFAULT_SARA.basis,
    surgeons: c.surgeons ?? DEFAULT_SARA.surgeons,
    clinics: c.clinics ?? DEFAULT_SARA.clinics,
  };
}

// Uma cirurgia conta para a Sara se o cirurgião OU a clínica estiverem cadastrados.
export function qualifiesForSara(record) {
  const { surgeons, clinics } = getSaraConfig();
  const cir = norm(record.cirurgiao);
  const cli = norm(record.clinica);

  const surgeonMatch = cir && surgeons.some((s) => {
    const n = norm(s);
    return n && (cir.includes(n) || n.includes(cir));
  });
  const clinicMatch = cli && clinics.some((c) => {
    const n = norm(c);
    return n && (cli.includes(n) || n.includes(cli));
  });
  return Boolean(surgeonMatch || clinicMatch);
}

// Valor base de uma cirurgia conforme a base de cálculo escolhida.
function baseValue(record, basis) {
  return basis === 'recebido' ? (record.valorPago || 0) : (record.valor || 0);
}

// Calcula a comissão da Sara sobre um conjunto de registros.
export function computeSaraSalary(records) {
  const { commissionRate, taxRate, basis } = getSaraConfig();
  const qualifying = records.filter(qualifiesForSara);
  const bruto = qualifying.reduce((a, r) => a + baseValue(r, basis), 0);
  const imposto = bruto * taxRate;
  const liquido = bruto - imposto;
  const comissao = liquido * commissionRate;
  return {
    qualifying,
    count: qualifying.length,
    bruto,
    imposto,
    liquido,
    comissao,
    commissionRate,
    taxRate,
    basis,
  };
}
