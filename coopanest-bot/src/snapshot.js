import fs from 'node:fs';
import path from 'node:path';

import { STATE_DIR } from './config.js';

const SNAPSHOT_FILE = path.join(STATE_DIR, 'cases.json');

/** Ultima leitura conhecida do portal, indexada por caseKey. */
export function loadSnapshot() {
  try {
    const data = JSON.parse(fs.readFileSync(SNAPSHOT_FILE, 'utf8'));
    return data && typeof data === 'object' ? data : {};
  } catch (err) {
    if (err.code !== 'ENOENT') console.error('[snapshot] arquivo ilegivel, recomecando:', err.message);
    return {};
  }
}

export function saveSnapshot(snapshot) {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    const tmp = `${SNAPSHOT_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(snapshot, null, 2));
    fs.renameSync(tmp, SNAPSHOT_FILE);
  } catch (err) {
    console.error('[snapshot] falha ao gravar:', err.message);
  }
}

export function countCases() {
  return Object.keys(loadSnapshot()).length;
}
