# Coopanest Sync

Serviço que loga no portal da **Coopanest Rio**, varre **todas as páginas** do site e mantém uma planilha do Google Sheets sempre atualizada com as cirurgias — marcando com ⚠️ tudo que mudou desde a última leitura.

Calcula também o **salário da Sara**: 5% do líquido (valor bruto − 20% de imposto) das cirurgias ligadas a DATBABY, Dr. Raphael Datrino e Dr. Thiago Dantas.

Sem WhatsApp e sem comandos: roda sozinho, do portal direto para a planilha.

---

## Como funciona

```
  a cada 60 min          ┌────────────────────────────────────────┐
  (ou POST /sync)   →    │ 1. login no portal (Playwright)        │
                         │ 2. varre o site inteiro em largura:    │
                         │    segue links, pagina listagens,      │
                         │    abre as telas de detalhe            │
                         └───────────────────┬────────────────────┘
                                             ↓
                         ┌────────────────────────────────────────┐
                         │ 3. só as páginas com cara de dado vão   │
                         │    para o Claude estruturar (JSON)      │  claude-sonnet-4-6
                         └───────────────────┬────────────────────┘
                                             ↓
                         ┌────────────────────────────────────────┐
                         │ 4. diff contra a última leitura         │  /data/cases.json
                         └───────────────────┬────────────────────┘
                                             ↓
                         ┌────────────────────────────────────────┐
                         │ 5. Google Sheets                        │
                         │    • Cirurgias   (⚠️ + linha destacada) │
                         │    • Salario Sara                       │
                         │    • Historico   (antes → depois)       │
                         └────────────────────────────────────────┘
```

**Sobre o plugin do Chrome:** a ideia original era o Claude varrer o site por uma extensão do navegador. Isso não funciona num serviço hospedado — a extensão só existe enquanto o seu Chrome está aberto. Aqui o serviço abre o portal **ele mesmo**, headless, com o seu login, dentro do container. Roda 24h sem depender do seu computador.

### A varredura não para na primeira página

A partir da página em que o login cai (ou das URLs em `COOPANEST_CASES_URL`), o crawler:

- segue **todos os links do mesmo domínio**, em largura, até `maxPages` (60) e `maxDepth` (3);
- **pagina as listagens** clicando em "Próxima" — e coleta os links de *cada* página da paginação, não só da última;
- abre as **telas de detalhe** de cada cirurgia e junta o que só existe lá (recurso de glosa, observações) com o que veio da listagem;
- **nunca clica em "Sair"/logout** — é o link que derrubaria a sessão no meio da varredura. Também pula download de arquivo, impressão, exclusão e `mailto:`/`javascript:`;
- **não manda página inútil para a IA**: menu, ajuda e avisos não têm data nem valor, então são descartados antes de gastar token.

---

## Estrutura

```
coopanest-bot/
  Dockerfile              node:20-slim + chromium
  package.json            ESM (type: module)
  railway.json            startCommand + healthcheck
  config.json             configuração editável (crawler, médicos, parceiros, colunas)
  src/
    index.js              Express: /health, /status, /salario, POST /sync — porta 3000
    scheduler.js          dispara a varredura no intervalo configurado
    coopanest.js          login + orquestra a varredura do portal
    crawler.js            percorre o site: links, paginação, filtros, deduplicação
    extractor.js          manda cada página para o Claude e normaliza as cirurgias
    prompt.js             buildSystemPrompt a partir do config.json
    anthropic.js          fetch para api.anthropic.com, timeout 120s, AbortController
    diff.js               ID estável por cirurgia + detecção de mudanças
    snapshot.js           última leitura conhecida (/data/cases.json)
    sheets.js             Google Sheets API v4: abas, upsert, histórico, salário
    salary.js             5% do líquido para a Sara, por mês
    sync.js               orquestra: varre → compara → grava na planilha
    format.js             dinheiro, datas e normalização de texto
    config.json loader    (src/config.js) com override em runtime
    state.js              última varredura (/data/state.json)
  scripts/
    selftest.js           21 testes offline (sem rede)
    e2e-login.js          detecção automática do formulário de login
    e2e-sync.js           portal falso multi-página, ponta a ponta
    sync-once.js          roda uma varredura pelo terminal
    scrape-debug.js       mostra o que o crawler vê, sem gastar IA
    check-syntax.js       node --check em tudo
```

---

## Endpoints

| Rota | O que faz |
|---|---|
| `GET /health` | estado do serviço (usado pelo healthcheck do Railway) |
| `GET /status` | última varredura, nº de cirurgias, link da planilha |
| `GET /salario` | cálculo do salário da Sara em JSON |
| `POST /sync` | dispara uma varredura agora (protegido por `SYNC_SECRET`, se definido) |

---

## Deploy no Railway

1. **Novo projeto → Deploy from GitHub** → repo `edumeloedumelo/graphify`, branch `claude/whatsapp-coopanest-bot-qn7e6b`
2. **Settings → Root Directory:** `coopanest-bot`
3. **Variables:** copie de `.env.example`
4. **Volume: Mount Path `/data`** — essencial. Sem isso o serviço esquece o que já viu a cada redeploy e trata tudo como novidade.

### Variáveis

```
ANTHROPIC_API_KEY=             ANTHROPIC_MODEL=claude-sonnet-4-6
COOPANEST_LOGIN_URL=           ANTHROPIC_MAX_TOKENS=4096
COOPANEST_USER=                COOPANEST_CASES_URL=    (vazio = começa pós-login)
COOPANEST_PASS=
GOOGLE_SHEET_ID=               GOOGLE_SERVICE_ACCOUNT_JSON=
STATE_DIR=/data                PORT=3000
SYNC_INTERVAL_MINUTES=60       SYNC_ON_BOOT=true       SYNC_SECRET=
CRAWL_MAX_PAGES=60             CRAWL_MAX_DEPTH=3
```

### Google Sheets

1. Google Cloud Console → novo projeto → ative a **Google Sheets API**
2. Crie uma **Service Account** → Keys → **Add key → JSON**
3. Cole o JSON inteiro (uma linha, ou o base64 dele) em `GOOGLE_SERVICE_ACCOUNT_JSON`
4. **Compartilhe a planilha com o e-mail da service account** (`...@....iam.gserviceaccount.com`) como **Editor** — sem isso dá 403
5. `GOOGLE_SHEET_ID` é o trecho da URL: `docs.google.com/spreadsheets/d/`**`ESTE_PEDAÇO`**`/edit`

As três abas (`Cirurgias`, `Salario Sara`, `Historico`) são criadas sozinhas na primeira execução.

---

## Ajustando ao portal real

O `config.json` traz seletores genéricos. Se o login falhar ou faltar página, veja o que o crawler está enxergando:

```bash
npm install && npx playwright install chromium
cp .env.example .env      # preencha COOPANEST_*
npm run scrape            # lista as páginas visitadas, marca as que iriam para a IA
npm run scrape -- --full  # imprime o conteúdo de cada página
```

- **Login falhou?** o serviço já tenta achar o formulário sozinho quando os seletores não batem (âncora no campo de senha). Se ainda assim falhar, ajuste `coopanest.selectors` (`username`, `password`, `submit`, `loggedIn`).
- **Faltou página?** aumente `crawl.maxPages` / `crawl.maxDepth`, ou coloque a URL da listagem em `COOPANEST_CASES_URL`.
- **Página de cirurgias sem a marca `[DADO]`?** acrescente uma palavra em `crawl.dataKeywords` (ou ponha `crawl.onlyPagesWithData: false` para mandar tudo para a IA).
- **Paginação não avançou?** acrescente o seletor do botão em `crawl.nextPageSelectors`.

Tudo isso muda em produção **sem redeploy**: o serviço lê `/data/config.override.json` por cima do `config.json`.

---

## Testes

```bash
npm test          # 21 testes offline: crawler, diff, salário, extração, planilha
npm run test:e2e  # login em formulários fora do padrão + portal falso multi-página
npm run check     # node --check em todos os arquivos
```

O `test:e2e` precisa de um Chromium; se o do Playwright não estiver instalado:

```bash
CHROMIUM_PATH=/caminho/para/chrome npm run test:e2e
```

---

## Detalhes que importam

- **Nada é reescrito à toa.** Cada cirurgia tem um ID estável (paciente + data + procedimento). Só entra na planilha o que é novo ou mudou de verdade — valores são comparados como número, então `4.200,00` e `4200` não contam como mudança.
- **Campo vazio não apaga dado.** Se uma leitura vier incompleta (portal fora do ar, sessão caída), o valor anterior é preservado em vez de virar "mudou para vazio".
- **Listagem + detalhe viram uma linha só.** A mesma cirurgia aparece nas duas telas; o resultado é a união dos campos preenchidos.
- **A sessão é reaproveitada** (`/data/coopanest-session.json`), então nem toda varredura precisa refazer login. Se o portal devolver a tela de login no meio da varredura, isso vira aviso no `/status` em vez de dado errado na planilha.
- **Uma varredura por vez** — o `POST /sync` responde 409 se já houver uma rodando, e o agendador pula o ciclo em vez de empilhar.
