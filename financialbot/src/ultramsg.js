// Envio de mensagens via UltraMsg + normalização do webhook de entrada.

const MAX_LEN = 4000;

export function splitMessage(text, maxLen = MAX_LEN) {
  if (!text) return [];
  if (text.length <= maxLen) return [text];
  const parts = [];
  let rest = text;
  while (rest.length > maxLen) {
    // corta preferencialmente em quebra de linha
    let cut = rest.lastIndexOf('\n', maxLen);
    if (cut < maxLen * 0.5) cut = maxLen;
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n+/, '');
  }
  if (rest) parts.push(rest);
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
  for (const chunk of splitMessage(body)) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token, to, body: chunk }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.error) {
        console.error('[ultramsg] falha no envio:', res.status, JSON.stringify(data.error || data));
      }
    } catch (err) {
      console.error('[ultramsg] erro de rede no envio:', err.message);
    }
  }
}

// Normaliza os vários formatos de payload do webhook UltraMsg em um objeto único.
export function parseWebhook(payload) {
  const d = payload?.data || payload || {};
  const eventType = payload?.event_type || payload?.eventType || '';
  if (eventType && !/message/i.test(eventType)) return null;

  const body = d.body || d.caption || '';
  const chatId = d.chatId || d.from || '';
  if (!chatId || typeof body !== 'string' || !body.trim()) return null;

  // em grupos, "author" identifica quem enviou; em conversa direta, é o próprio from
  const author = d.author || d.participant || d.from || chatId;
  return {
    chatId,
    author,
    senderName: d.pushname || d.pushName || d.notifyName || '',
    body: body.trim(),
    fromMe: Boolean(d.fromMe || d.self),
    type: d.type || 'chat',
  };
}

// número "cru" para comparação com ADMIN_NUMBERS / ALLOWED_CHATS
export function bareNumber(jid) {
  return String(jid || '').replace(/@.*$/, '').replace(/\D/g, '');
}
