/**
 * Confere se a planilha está acessível antes de subir para o Railway.
 * Diz exatamente o que está errado: JSON inválido, ID errado ou planilha
 * não compartilhada com a service account.
 *
 *   node scripts/check-sheets.js
 */
import 'dotenv/config';

const ok = (texto) => console.log(`  ✓ ${texto}`);
const erro = (texto) => console.log(`  ✗ ${texto}`);

function parseCredentials(raw) {
  const text = raw.trim().startsWith('{') ? raw : Buffer.from(raw, 'base64').toString('utf8');
  return JSON.parse(text);
}

console.log('\nConferindo o acesso à planilha\n');

const sheetId = process.env.GOOGLE_SHEET_ID;
const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;

if (!sheetId) {
  erro('GOOGLE_SHEET_ID não está definida.');
  console.log('\n    O ID é o trecho do meio da URL da planilha:');
  console.log('    docs.google.com/spreadsheets/d/ESTE_PEDACO/edit\n');
  process.exit(1);
}
ok(`GOOGLE_SHEET_ID definida (${sheetId.slice(0, 12)}…)`);

if (!raw) {
  erro('GOOGLE_SERVICE_ACCOUNT_JSON não está definida.');
  console.log('\n    Cole o conteúdo do arquivo .json da service account, ou o base64 dele:');
  console.log('    base64 -i ~/Downloads/seu-arquivo.json | pbcopy\n');
  process.exit(1);
}

let creds;
try {
  creds = parseCredentials(raw);
} catch (err) {
  erro(`GOOGLE_SERVICE_ACCOUNT_JSON não é um JSON válido nem um base64 de JSON (${err.message}).`);
  console.log('\n    Copie o arquivo inteiro, das chaves { até } — ou use o base64.\n');
  process.exit(1);
}

for (const campo of ['client_email', 'private_key', 'project_id']) {
  if (!creds[campo]) {
    erro(`falta o campo "${campo}" no JSON — esse arquivo não parece ser de uma service account.`);
    console.log('\n    Baixe de novo em: Credenciais → sua conta de serviço → Chaves → Adicionar chave → JSON\n');
    process.exit(1);
  }
}
ok(`JSON da service account lido (projeto ${creds.project_id})`);
console.log(`\n    E-mail da service account:\n    ${creds.client_email}\n`);

const { google } = await import('googleapis');
const auth = new google.auth.GoogleAuth({
  credentials: { ...creds, private_key: creds.private_key.replace(/\\n/g, '\n') },
  scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});

let sheets;
try {
  sheets = google.sheets({ version: 'v4', auth: await auth.getClient() });
  ok('autenticado no Google');
} catch (err) {
  erro(`falha ao autenticar: ${err.message}`);
  process.exit(1);
}

// ---- leitura ----
let titulo;
try {
  const { data } = await sheets.spreadsheets.get({ spreadsheetId: sheetId });
  titulo = data.properties?.title;
  ok(`planilha encontrada: "${titulo}"`);
  console.log(`    abas atuais: ${(data.sheets || []).map((s) => s.properties.title).join(', ') || '(nenhuma)'}`);
} catch (err) {
  const status = err.status || err.code;
  erro(`não consegui abrir a planilha (${status || err.message})`);
  if (status === 403) {
    console.log('\n    A planilha existe, mas a service account não tem acesso.');
    console.log('    Abra a planilha → Compartilhar → cole o e-mail abaixo como *Editor*:');
    console.log(`    ${creds.client_email}\n`);
  } else if (status === 404) {
    console.log('\n    ID não encontrado. Confira se copiou o trecho certo da URL.\n');
  } else {
    console.log(`\n    ${err.message}\n`);
  }
  process.exit(1);
}

// ---- escrita ----
try {
  const { ensureTabs } = await import('../src/sheets.js');
  await ensureTabs();
  ok('escrita liberada — as três abas foram criadas/conferidas');
} catch (err) {
  const status = err.status || err.code;
  erro(`não consegui escrever na planilha (${status || err.message})`);
  if (status === 403) {
    console.log('\n    A service account está como *Leitor*. Troque para *Editor* no compartilhamento.\n');
  } else {
    console.log(`\n    ${err.message}\n`);
  }
  process.exit(1);
}

console.log('\nTudo certo. Pode configurar as mesmas variáveis no Railway.\n');
