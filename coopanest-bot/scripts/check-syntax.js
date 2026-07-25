import { readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dirs = ['src', 'scripts'];

let failures = 0;

for (const dir of dirs) {
  const full = path.join(root, dir);
  for (const file of readdirSync(full).filter((name) => name.endsWith('.js'))) {
    const target = path.join(full, file);
    try {
      execFileSync(process.execPath, ['--check', target], { stdio: 'pipe' });
      console.log(`ok   ${dir}/${file}`);
    } catch (err) {
      failures += 1;
      console.error(`FAIL ${dir}/${file}\n${err.stderr?.toString() || err.message}`);
    }
  }
}

process.exit(failures === 0 ? 0 : 1);
