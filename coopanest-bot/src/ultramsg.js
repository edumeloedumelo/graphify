import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const MAX_CHUNK = 4000;
const MAX_PDF_BYTES = 10 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 60_000;

function instanceId() {
  const id = process.env.ULTRAMSG_INSTANCE_ID;
  if (!id) throw new Error('ULTRAMSG_INSTANCE_ID nao configurada');
  return id;
}

function token() {
  const value = process.env.ULTRAMSG_TOKEN;
  if (!value) throw new Error('ULTRAMSG_TOKEN nao configurado');
  return value;
}

export function apiBase() {
  // ULTRAMSG_BASE_URL existe para apontar os testes a um servidor local
  const base = (process.env.ULTRAMSG_BASE_URL || 'https://api.ultramsg.com').replace(/\/$/, '');
  return `${base}/${instanceId()}`;
}

/** Quebra o texto em blocos de ate 4000 caracteres, sempre em quebra de linha. */
export function splitMessage(text, limit = MAX_CHUNK) {
  const input = String(text ?? '');
  if (input.length <= limit) return input ? [input] : [];

  const chunks = [];
  let current = '';

  for (const line of input.split('\n')) {
    if (line.length > limit) {
      if (current) {
        chunks.push(current);
        current = '';
      }
      for (let i = 0; i < line.length; i += limit) chunks.push(line.slice(i, i + limit));
      continue;
    }
    const candidate = current ? `${current}\n${line}` : line;
    if (candidate.length > limit) {
      chunks.push(current);
      current = line;
    } else {
      current = candidate;
    }
  }

  if (current) chunks.push(current);
  return chunks.filter((chunk) => chunk.trim().length > 0);
}

async function postForm(endpoint, params) {
  const body = new URLSearchParams({ token: token(), ...params });
  const response = await fetch(`${apiBase()}${endpoint}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });
  const raw = await response.text();
  if (!response.ok) throw new Error(`UltraMsg ${endpoint} ${response.status}: ${raw.slice(0, 300)}`);
  try {
    return JSON.parse(raw);
  } catch {
    return { raw };
  }
}

/** Envia texto para um chat, quebrando automaticamente em varias mensagens. */
export async function sendText(chatId, text) {
  if (!chatId) throw new Error('sendText: chatId ausente');
  const chunks = splitMessage(text);
  const results = [];
  for (const chunk of chunks) {
    results.push(await postForm('/messages/chat', { to: chatId, body: chunk }));
    if (chunks.length > 1) await new Promise((resolve) => setTimeout(resolve, 700));
  }
  return results;
}

export async function sendDocument(chatId, { url, filename = 'arquivo.pdf', caption = '' }) {
  return postForm('/messages/document', { to: chatId, document: url, filename, caption });
}

/** Detecta o tipo real do arquivo pelos magic bytes — nao confia no content-type. */
export function sniffMime(buffer) {
  if (!buffer || buffer.length < 12) return null;
  const hex = buffer.subarray(0, 12).toString('hex').toLowerCase();
  const ascii = buffer.subarray(0, 12).toString('latin1');

  if (ascii.startsWith('%PDF')) return 'application/pdf';
  if (hex.startsWith('ffd8ff')) return 'image/jpeg';
  if (hex.startsWith('89504e470d0a1a0a')) return 'image/png';
  if (ascii.startsWith('GIF87a') || ascii.startsWith('GIF89a')) return 'image/gif';
  if (ascii.startsWith('RIFF') && buffer.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  return null;
}

const IMAGE_MIMES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);

/** Comprime um PDF com Ghostscript. Devolve o buffer original se o gs falhar. */
export async function compressPdf(buffer) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdf-'));
  const input = path.join(dir, 'in.pdf');
  const output = path.join(dir, 'out.pdf');

  try {
    fs.writeFileSync(input, buffer);
    await execFileAsync(
      'gs',
      [
        '-sDEVICE=pdfwrite',
        '-dCompatibilityLevel=1.4',
        '-dPDFSETTINGS=/ebook',
        '-dNOPAUSE',
        '-dQUIET',
        '-dBATCH',
        '-dDetectDuplicateImages=true',
        `-sOutputFile=${output}`,
        input,
      ],
      { timeout: 90_000, maxBuffer: 1024 * 1024 },
    );
    const compressed = fs.readFileSync(output);
    return compressed.length > 0 && compressed.length < buffer.length ? compressed : buffer;
  } catch (err) {
    console.error('[ultramsg] ghostscript falhou:', err.message);
    return buffer;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Baixa uma midia e devolve um content block pronto para a Anthropic API.
 * Lanca erro descritivo quando a URL nao aponta para um arquivo de verdade.
 */
export async function downloadMediaBlock({ url, filename = '', mime = '' }) {
  if (!url) throw new Error('midia sem URL');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);

  let response;
  try {
    response = await fetch(url, { signal: controller.signal, redirect: 'follow' });
  } catch (err) {
    throw new Error(
      err.name === 'AbortError' ? `timeout baixando ${filename || url}` : `falha baixando ${filename || url}: ${err.message}`,
    );
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) throw new Error(`download ${response.status} em ${filename || url}`);

  const contentType = (response.headers.get('content-type') || '').toLowerCase();
  if (contentType.includes('text/html')) {
    throw new Error(
      `${filename || 'arquivo'}: a URL devolveu uma pagina HTML, nao o arquivo (link externo nao acessivel pelo bot)`,
    );
  }

  let buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length === 0) throw new Error(`${filename || 'arquivo'}: download vazio`);

  const detected = sniffMime(buffer) || (mime || contentType).split(';')[0].trim();
  if (!detected) throw new Error(`${filename || 'arquivo'}: tipo nao reconhecido`);

  if (detected === 'application/pdf' && buffer.length > MAX_PDF_BYTES) {
    buffer = await compressPdf(buffer);
    if (buffer.length > MAX_PDF_BYTES) {
      throw new Error(
        `${filename || 'arquivo'}: PDF continua com ${(buffer.length / 1024 / 1024).toFixed(1)}MB apos compressao`,
      );
    }
  }

  const data = buffer.toString('base64');

  if (detected === 'application/pdf') {
    return {
      block: { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data } },
      filename,
      bytes: buffer.length,
    };
  }

  if (IMAGE_MIMES.has(detected)) {
    return {
      block: { type: 'image', source: { type: 'base64', media_type: detected, data } },
      filename,
      bytes: buffer.length,
    };
  }

  throw new Error(`${filename || 'arquivo'}: tipo ${detected} nao suportado pelo Claude`);
}
