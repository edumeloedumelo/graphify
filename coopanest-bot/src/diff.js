import crypto from 'node:crypto';

import { normalize, toNumber } from './format.js';
import { getConfig } from './config.js';

/** Identidade estavel de uma cirurgia: paciente + data + procedimento. */
export function caseKey(item) {
  const seed = [normalize(item.paciente), normalize(item.data), normalize(item.procedimento)].join('|');
  return crypto.createHash('sha1').update(seed).digest('hex').slice(0, 10);
}

function sameValue(before, after) {
  const beforeNum = toNumber(before);
  const afterNum = toNumber(after);
  if (beforeNum !== null && afterNum !== null) return Math.abs(beforeNum - afterNum) < 0.005;
  return normalize(before) === normalize(after);
}

function isEmpty(value) {
  return value === '' || value === null || value === undefined;
}

/** Campos que mudaram entre duas versoes do mesmo caso. */
export function diffCase(before, after, watchedFields) {
  const fields = watchedFields || getConfig().watchedFields || [];
  const changes = [];

  for (const field of fields) {
    const from = before?.[field];
    const to = after?.[field];
    // portal as vezes devolve campo vazio numa leitura; nao trata isso como mudanca
    if (isEmpty(to) && !isEmpty(from)) continue;
    if (sameValue(from, to)) continue;
    changes.push({ field, from: isEmpty(from) ? '' : from, to: isEmpty(to) ? '' : to });
  }

  return changes;
}

/**
 * Compara a leitura nova com o snapshot anterior.
 * @returns {{added:Array, updated:Array, unchanged:Array, merged:Object}}
 */
export function diffSnapshot(previous = {}, incoming = []) {
  const cfg = getConfig();
  const watched = cfg.watchedFields || [];

  const added = [];
  const updated = [];
  const unchanged = [];
  const merged = { ...previous };

  for (const item of incoming) {
    const id = caseKey(item);
    const before = previous[id];
    const record = { ...item, id };

    if (!before) {
      added.push(record);
      merged[id] = record;
      continue;
    }

    const changes = diffCase(before, item, watched);
    if (changes.length === 0) {
      unchanged.push({ ...before, ...record });
      merged[id] = { ...before, ...record };
      continue;
    }

    // preserva campos que a leitura nova deixou vazios
    const next = { ...before };
    for (const [key, value] of Object.entries(record)) {
      if (!isEmpty(value)) next[key] = value;
    }

    updated.push({ ...next, changes });
    merged[id] = next;
  }

  return { added, updated, unchanged, merged };
}

/** Texto curto de uma mudanca, para WhatsApp e para a coluna "Mudancas". */
export function describeChange(change) {
  const from = change.from === '' ? '(vazio)' : change.from;
  const to = change.to === '' ? '(vazio)' : change.to;
  return `${change.field}: ${from} → ${to}`;
}

export function describeChanges(changes = []) {
  return changes.map(describeChange).join(' | ');
}
