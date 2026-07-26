/**
 * Quem pode chamar /inspecionar e para onde ele pode navegar.
 *
 * O endpoint abre uma sessão autenticada no portal: sem trava, qualquer um que
 * descubra a URL do serviço poderia mandá-lo visitar um host arbitrário usando
 * os cookies do usuário.
 */

/** Desligado por completo com INSPECTOR_ENABLED=false. */
export function inspetorHabilitado() {
  return process.env.INSPECTOR_ENABLED !== 'false';
}

/**
 * Confere o Authorization: Bearer <INSPECTOR_TOKEN>.
 * Sem token configurado o endpoint fica FECHADO — o padrão seguro é negar,
 * não liberar.
 */
export function autorizado(req) {
  const esperado = process.env.INSPECTOR_TOKEN || '';
  if (!esperado) return { ok: false, status: 403, motivo: 'INSPECTOR_TOKEN nao configurado — endpoint desativado' };

  const cabecalho = req.get?.('authorization') || '';
  const recebido = cabecalho.startsWith('Bearer ') ? cabecalho.slice(7).trim() : '';
  if (!recebido) return { ok: false, status: 401, motivo: 'envie Authorization: Bearer <token>' };
  if (recebido !== esperado) return { ok: false, status: 401, motivo: 'token invalido' };
  return { ok: true };
}

/** Hosts permitidos: os configurados ou, na falta, o host do login do portal. */
export function hostsPermitidos() {
  const lista = (process.env.INSPECTOR_HOSTS || '')
    .split(',')
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean);
  if (lista.length) return lista;

  try {
    return [new URL(process.env.COOPANEST_LOGIN_URL || '').hostname.toLowerCase()];
  } catch {
    return [];
  }
}

/**
 * Só HTTPS, só host autorizado, nunca IP nem endereço local.
 * @returns {string|null} motivo da recusa, ou null quando a URL é aceitável
 */
export function motivoRecusarUrl(url, permitidos = hostsPermitidos()) {
  let alvo;
  try {
    alvo = new URL(url);
  } catch {
    return 'URL invalida';
  }

  if (alvo.protocol !== 'https:') return 'apenas https e aceito';

  const host = alvo.hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal')) return 'endereco local';
  // qualquer host numerico (IPv4) ou IPv6 literal fica de fora: evita
  // alcançar a rede interna de onde o serviço roda
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':')) return 'endereco IP nao e aceito';
  if (permitidos.length === 0) return 'nenhum host autorizado configurado';
  if (!permitidos.some((permitido) => host === permitido || host.endsWith(`.${permitido}`))) {
    return `host "${host}" nao autorizado`;
  }
  return null;
}
