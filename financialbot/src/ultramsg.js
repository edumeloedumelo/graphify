// ultramsg.js — envio de mensagens via UltraMsg API

const MAX_LEN = 4000;

export function splitMessage(text, maxLen = MAX_LEN) {
  if (!text) return [];
  if (text.length <= maxLen) return [text];
  const parts = [];
  let rest = text;
  while (rest.length > maxLen) {
    // tenta quebrar na última linha antes do limite
    let cut = rest.lastIndexOf('\n', maxLen);
    if (cut < maxLen * 0.5) cut = maxLen;
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n+/, '');
  }
  if (rest.length) parts.push(rest);
  return parts;
}

export async function sendMessage(to, body) {
  const instance = process.env.ULTRAMSG_INSTANCE_ID;
  const token = process.env.ULTRAMSG_TOKEN;
  if (!instance || !token) {
    console.error('[ultramsg] ULTRAMSG_INSTANCE_ID/ULTRAMSG_TOKEN não configurados');
    return;
  }
  const url = `https://api.ultramsg.com/${instance}/messages/chat`;
  for (const part of splitMessage(body)) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token, to, body: part }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || json.error) {
        console.error('[ultramsg] falha ao enviar:', res.status, JSON.stringify(json.error || json));
      } else {
        console.log(`[ultramsg] mensagem enviada para ${to} (${part.length} chars)`);
      }
    } catch (err) {
      console.error('[ultramsg] erro de rede:', err.message);
    }
  }
}
