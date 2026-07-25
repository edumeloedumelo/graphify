// ANTHROPIC_BASE_URL existe para apontar os testes a um servidor local
const API_URL = `${(process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com').replace(/\/$/, '')}/v1/messages`;
const API_VERSION = '2023-06-01';
const TIMEOUT_MS = 120_000;

export const DEFAULT_MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6';

export function maxTokens() {
  const parsed = Number(process.env.ANTHROPIC_MAX_TOKENS);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 4096;
}

export class AnthropicError extends Error {
  constructor(message, { status = 0, body = '', retryable = false } = {}) {
    super(message);
    this.name = 'AnthropicError';
    this.status = status;
    this.body = body;
    this.retryable = retryable;
  }
}

/**
 * Chama a Messages API com timeout duro de 120s via AbortController.
 * `messages` segue o formato da API (array de {role, content}).
 */
export async function callAnthropic({
  system,
  messages,
  model = DEFAULT_MODEL,
  max_tokens = maxTokens(),
  temperature = 0,
} = {}) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new AnthropicError('ANTHROPIC_API_KEY nao configurada');
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new AnthropicError('nenhuma mensagem para enviar');
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  const payload = { model, max_tokens, temperature, messages };
  if (system) payload.system = system;

  let response;
  try {
    response = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': API_VERSION,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new AnthropicError(`timeout de ${TIMEOUT_MS / 1000}s na Anthropic API`, { retryable: true });
    }
    throw new AnthropicError(`falha de rede: ${err.message}`, { retryable: true });
  } finally {
    clearTimeout(timer);
  }

  const raw = await response.text();

  if (!response.ok) {
    const retryable = response.status === 429 || response.status >= 500;
    throw new AnthropicError(`Anthropic API ${response.status}`, {
      status: response.status,
      body: raw.slice(0, 1500),
      retryable,
    });
  }

  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new AnthropicError('resposta da Anthropic nao e JSON', { body: raw.slice(0, 500) });
  }

  const text = (data.content || [])
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
    .trim();

  return { text, stopReason: data.stop_reason, usage: data.usage, raw: data };
}

/** Extrai o primeiro objeto/array JSON de uma resposta em texto (tolera cercas de codigo). */
export function extractJson(text) {
  if (!text) return null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = (fenced ? fenced[1] : text).trim();

  try {
    return JSON.parse(candidate);
  } catch {
    // continua: procura o primeiro bloco balanceado
  }

  const start = candidate.search(/[[{]/);
  if (start === -1) return null;
  const open = candidate[start];
  const close = open === '[' ? ']' : '}';
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < candidate.length; i += 1) {
    const char = candidate[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === open) depth += 1;
    else if (char === close) {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(candidate.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}
