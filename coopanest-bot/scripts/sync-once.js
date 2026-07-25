import 'dotenv/config';

import { runSync } from '../src/sync.js';

const report = await runSync({ trigger: 'cli' });
console.log(JSON.stringify(report, null, 2));
process.exit(report.error ? 1 : 0);
