import { getConfig } from './config.js';
import { runSync, isSyncRunning } from './sync.js';

let timer = null;

function intervalMinutes() {
  const fromEnv = Number(process.env.SYNC_INTERVAL_MINUTES);
  if (Number.isFinite(fromEnv) && fromEnv > 0) return fromEnv;
  const fromConfig = Number(getConfig().sync?.intervalMinutes);
  return Number.isFinite(fromConfig) && fromConfig > 0 ? fromConfig : 60;
}

function runOnBoot() {
  if (process.env.SYNC_ON_BOOT !== undefined) return process.env.SYNC_ON_BOOT !== 'false';
  return getConfig().sync?.runOnBoot !== false;
}

async function tick(trigger) {
  if (isSyncRunning()) {
    console.log('[scheduler] pulei: sincronizacao anterior ainda rodando');
    return;
  }
  try {
    await runSync({ trigger });
  } catch (err) {
    console.error('[scheduler] erro nao tratado:', err.message);
  }
}

/** Liga a varredura periodica do portal. */
export function startScheduler() {
  const minutes = intervalMinutes();
  const ms = minutes * 60 * 1000;

  if (timer) clearInterval(timer);
  timer = setInterval(() => tick('agendado'), ms);
  timer.unref?.();

  console.log(`[scheduler] varredura automatica a cada ${minutes} min`);

  if (runOnBoot()) {
    // atraso curto para o healthcheck do Railway responder antes da primeira varredura
    setTimeout(() => tick('boot'), 20_000).unref?.();
  }

  return { intervalMinutes: minutes };
}

export function stopScheduler() {
  if (timer) clearInterval(timer);
  timer = null;
}
