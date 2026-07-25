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
  // réplica do portal real: escolha de tipo de usuário + campo CRM.
  // Sem marcar o tipo, o servidor responde "Usuário ou senha Inválido".
  coopanest: `<h2>Entre na plataforma da Coopanest Rio</h2>
    <form method="POST" action="/login">
      <p>Selecione o tipo de usuário que deseja entrar</p>
      <label><input type="radio" name="tipo" value="cooperado"/> Cooperado</label>
      <label><input type="radio" name="tipo" value="administrador"/> Administrador</label>
      <input name="crm" type="text" placeholder="CRM"/>
      <input name="senha" type="password" placeholder="Senha"/>
      <button type="submit">Entrar na plataforma</button>
      <a href="/esqueci">Esqueceu a senha?</a>
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
let painelSemLogout = false;

const portal = http.createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => {
    body += chunk;
  });
  req.on('end', () => {
    const url = new URL(req.url, 'http://localhost');

    if (url.pathname === '/login' && req.method === 'POST') {
      const params = new URLSearchParams(body);
      recebido = { usuario: '', senha: '', tipo: params.get('tipo') || '' };
      for (const [key, value] of params) {
        if (/senha|pwd|pass/i.test(key)) recebido.senha = value;
        else if (/tipo/i.test(key)) continue;
        else if (value) recebido.usuario = value;
      }

      // igual ao portal real: sem tipo de usuário, recusa o login
      if (cenarioAtual === 'coopanest' && !recebido.tipo) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(
          `<html><body><h1>Coopanest</h1>${cenarios[cenarioAtual]}` +
            '<p>Não foi possível logar. Usuário ou senha Inválido</p></body></html>',
        );
        return;
      }

      res.writeHead(302, { location: '/painel', 'set-cookie': 'sessao=ok; Path=/' });
      res.end();
      return;
    }

    if (url.pathname === '/painel') {
      // painelSemLogout: portal cuja area logada nao tem link "Sair" reconhecivel
      const menu = painelSemLogout
        ? '<button onclick="encerrar()">Encerrar sessão</button>'
        : '<a href="/logout">Sair</a>';
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(`<html><body>${menu}<h1>Painel</h1><p>Bem-vindo, Dr. Eduardo.</p></body></html>`);
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
process.env.COOPANEST_USER = '52561';
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
    if (esperado.tipo) assert.equal(recebido.tipo, esperado.tipo, 'tipo de usuario nao foi marcado');
    console.log(`  ok  ${nome}`);
  } catch (err) {
    failures.push(nome);
    console.error(`  FAIL ${nome}: ${err.message}`);
  }
}

console.log('\ndeteccao automatica do formulario de login\n');

await check('campos com nomes inesperados e botao sem type=submit', 'incomum', {
  usuario: '52561',
  senha: 'segredo123',
});
await check('formulario sem botao (envia com Enter)', 'semBotao', {
  usuario: '52561',
  senha: 'segredo123',
});
await check('ignora campo de texto escondido', 'comCampoOculto', {
  usuario: '52561',
  senha: 'segredo123',
});

await check('portal da Coopanest: marca o tipo de usuario e preenche o CRM', 'coopanest', {
  usuario: '52561',
  senha: 'segredo123',
  tipo: 'cooperado',
});

// o seletor 'loggedIn' e um chute: se o portal nao tiver link de logout, o login
// ainda tem que ser dado como bem-sucedido (senao e falso negativo)
painelSemLogout = true;
await check('area logada sem link "Sair" nao e tratada como falha', 'incomum', {
  usuario: '52561',
  senha: 'segredo123',
});
painelSemLogout = false;

console.log(`\n${failures.length === 0 ? 'todos os passos ok' : `${failures.length} falha(s)`}\n`);

portal.close();
fs.rmSync(process.env.STATE_DIR, { recursive: true, force: true });
process.exit(failures.length === 0 ? 0 : 1);
