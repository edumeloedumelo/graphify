/**
 * Testa a detecção automática do formulário de login.
 *
 * O portal falso usa nomes de campo que NÃO batem com os seletores do config
 * (`txtCPF` / `txtSenha`, botão sem type=submit) — é o cenário provável num
 * portal real que eu nunca vi por dentro. O login precisa funcionar mesmo assim.
 *
 *   CHROMIUM_PATH=/caminho/para/chrome node scripts/e2e-login.js
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const cenarios = {
  // campos com nomes inesperados e botão que não é type=submit
  incomum: `<form method="POST" action="/login">
      <input name="txtCPF" id="cpf" type="text" placeholder="CPF"/>
      <input name="txtSenha" id="senha" type="password" placeholder="Senha"/>
      <button onclick="this.form.submit()">Acessar o sistema</button>
    </form>`,
  // formulário sem botão nenhum: só dá para enviar com Enter
  semBotao: `<form method="POST" action="/login">
      <input name="matricula" type="text"/>
      <input name="pwd" type="password"/>
    </form>`,
  // campo escondido antes do real, para conferir que ele é ignorado
  comCampoOculto: `<form method="POST" action="/login">
      <input name="fake" type="text" style="display:none"/>
      <input name="usuario_real" type="text"/>
      <input name="senha_real" type="password"/>
      <input type="submit" value="Entrar"/>
    </form>`,
};

let cenarioAtual = 'incomum';
let recebido = null;

const portal = http.createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => {
    body += chunk;
  });
  req.on('end', () => {
    const url = new URL(req.url, 'http://localhost');

    if (url.pathname === '/login' && req.method === 'POST') {
      const params = new URLSearchParams(body);
      recebido = { usuario: '', senha: '' };
      for (const [key, value] of params) {
        if (/senha|pwd|pass/i.test(key)) recebido.senha = value;
        else if (value) recebido.usuario = value;
      }
      res.writeHead(302, { location: '/painel', 'set-cookie': 'sessao=ok; Path=/' });
      res.end();
      return;
    }

    if (url.pathname === '/painel') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end('<html><body><a href="/logout">Sair</a><h1>Painel</h1></body></html>');
      return;
    }

    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(`<html><body><h1>Coopanest</h1>${cenarios[cenarioAtual]}</body></html>`);
  });
});

await new Promise((resolve) => portal.listen(0, '127.0.0.1', resolve));
const port = portal.address().port;

process.env.STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'coopanest-login-'));
process.env.COOPANEST_LOGIN_URL = `http://127.0.0.1:${port}/login`;
process.env.COOPANEST_USER = 'dr.eduardo';
process.env.COOPANEST_PASS = 'segredo123';
process.env.ANTHROPIC_API_KEY = 'nao-usada-neste-teste';

const { saveOverride } = await import('../src/config.js');
// seletores propositalmente errados, como se o portal real fosse diferente do chute
saveOverride({
  coopanest: {
    selectors: {
      username: "input[name='usuario']",
      password: "input[name='password']",
      submit: "button[type='submit']",
      loggedIn: "a[href*='logout']",
    },
  },
  crawl: { maxPages: 1, maxDepth: 0, waitAfterLoadMs: 100 },
});

const { scrapeCases } = await import('../src/coopanest.js');

const failures = [];
async function check(nome, cenario, esperado) {
  cenarioAtual = cenario;
  recebido = null;
  fs.rmSync(path.join(process.env.STATE_DIR, 'coopanest-session.json'), { force: true });

  try {
    const { warnings } = await scrapeCases({ debug: true });
    assert.ok(recebido, `o formulario nao foi enviado (avisos: ${warnings.join('; ')})`);
    assert.equal(recebido.usuario, esperado.usuario);
    assert.equal(recebido.senha, esperado.senha);
    console.log(`  ok  ${nome}`);
  } catch (err) {
    failures.push(nome);
    console.error(`  FAIL ${nome}: ${err.message}`);
  }
}

console.log('\ndeteccao automatica do formulario de login\n');

await check('campos com nomes inesperados e botao sem type=submit', 'incomum', {
  usuario: 'dr.eduardo',
  senha: 'segredo123',
});
await check('formulario sem botao (envia com Enter)', 'semBotao', {
  usuario: 'dr.eduardo',
  senha: 'segredo123',
});
await check('ignora campo de texto escondido', 'comCampoOculto', {
  usuario: 'dr.eduardo',
  senha: 'segredo123',
});

console.log(`\n${failures.length === 0 ? 'todos os passos ok' : `${failures.length} falha(s)`}\n`);

portal.close();
fs.rmSync(process.env.STATE_DIR, { recursive: true, force: true });
process.exit(failures.length === 0 ? 0 : 1);
