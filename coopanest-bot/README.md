# Coopanest Bot

Bot que varre o portal da **Coopanest Rio**, mantém uma planilha do Google Sheets com todas as cirurgias e avisa no WhatsApp sempre que algo muda — com ⚠️ em cima da mudança.

Também calcula o **salário da Sara**: 5% do líquido (valor bruto − 20% de imposto) das cirurgias ligadas a DATBABY / Dr. Raphael Datrino / Dr. Thiago Dantas.

---

## Como funciona

```
                    ┌─────────────────────────────┐
   a cada 60 min →  │  Playwright loga no portal  │
   ou /sync         │  e lê a tabela de cirurgias │
                    └──────────────┬──────────────┘
                                   ↓
                    ┌─────────────────────────────┐
                    │  Claude estrutura os dados  │  ← claude-sonnet-4-6
                    └──────────────┬──────────────┘
                                   ↓
                    ┌─────────────────────────────┐
                    │  diff contra a última leitura│ (/data/cases.json)
                    └──────────────┬──────────────┘
                                   ↓
              ┌────────────────────┴────────────────────┐
              ↓                                         ↓
   ┌────────────────────┐                   ┌────────────────────────┐
   │  Google Sheets     │                   │  WhatsApp (UltraMsg)   │
   │  • Cirurgias       │                   │  • grupo Dr. Eduardo   │
   │  • Salario Sara    │                   │  • grupo Dra. Fernanda │
   │  • Historico       │                   │  ⚠️ só o que mudou      │
   └────────────────────┘                   └────────────────────────┘
```

**Sobre o plugin do Chrome:** a ideia original era o Claude varrer o site por uma extensão do navegador. Isso não funciona num bot hospedado — a extensão só existe enquanto o seu Chrome está aberto, e o Railway não tem navegador na sua máquina. Aqui o bot abre o portal **ele mesmo**, headless, com o seu login, dentro do container. O efeito é o mesmo e roda 24h sem depender do seu computador.

---

## Estrutura

```
coopanest-bot/
  Dockerfile              node:20-slim + ghostscript + chromium
  package.json            ESM (type: module)
  railway.json            startCommand + healthcheck
  config.json             configuração editável (médicos, parceiros, colunas, seletores)
  src/
    index.js              Express: /webhook, /health, /status, /sync — porta 3000
    router.js             recebe o webhook do UltraMsg, cacheia mídias, roteia comandos
    commands.js           handlers, lock por chatId, /analisar com setLastTime antecipado
    parser.js             splitIntoCases: abertura/fechamento, _alreadyAnalyzed
    triage.js             monta contexto + mídias → Anthropic → retry sem blocos ruins
    prompt.js             buildSystemPrompt a partir do config.json
    format.js             limpa markdown do Claude → formato WhatsApp; dinheiro e datas
    anthropic.js          fetch para api.anthropic.com, timeout 120s, AbortController
    ultramsg.js           sendText, splitMessage 4000, downloadMediaBlock, compressPdf
    state.js              lastTime por chatId — STATE_DIR = process.env.STATE_DIR || '/data'
    mediastore.js         URLs de mídia por chat — STATE_DIR = '/data'
    fetcher.js            GET /chats/messages, LOOKBACK_SECONDS=3600, ordena por timestamp
    coopanest.js          login + varredura do portal (Playwright)
    sheets.js             Google Sheets API v4: abas, upsert, histórico, salário
    diff.js               caseKey estável + detecção de mudanças
    salary.js             5% do líquido para a Sara, por mês
    snapshot.js           última leitura conhecida (/data/cases.json)
    sync.js               orquestra: varre → compara → planilha → WhatsApp
    scheduler.js          varredura automática no intervalo configurado
  scripts/
    selftest.js           28 testes offline (sem rede)
    e2e-analisar.js       fluxo do grupo ponta a ponta, com mocks
    e2e-sync.js           portal falso + login + diff + aviso, com mocks
    sync-once.js          roda uma varredura pelo terminal
    scrape-debug.js       mostra o que o navegador vê (para ajustar seletores)
    check-syntax.js       node --check em tudo
```

---

## Comandos no WhatsApp

| Comando | O que faz |
|---|---|
| `/sync` | varre o portal agora e atualiza a planilha |
| `/status` | última varredura, nº de cirurgias monitoradas, config |
| `/salario` | cálculo do salário da Sara |
| `/planilha` | link da planilha |
| `/analisar` | lê os casos digitados no grupo e joga na planilha |
| `/ajuda` | lista os comandos |

A varredura roda sozinha; os comandos são para quando você quiser forçar.

---

## Deploy no Railway

1. **Novo projeto → Deploy from GitHub** → repo `edumeloedumelo/graphify`, branch `claude/whatsapp-coopanest-bot-qn7e6b`
2. **Settings → Root Directory:** `coopanest-bot`
3. **Variables:** copie de `.env.example` (lista abaixo)
4. **Volume: Mount Path `/data`** — essencial. Sem isso o bot esquece o que já viu a cada redeploy e reenvia tudo como novidade.
5. **UltraMsg → Webhook:** URL `https://SEU-DOMINIO.up.railway.app/webhook`, **Webhook Download Media: ON**

### Variáveis

```
ULTRAMSG_INSTANCE_ID=          ANTHROPIC_MODEL=claude-sonnet-4-6
ULTRAMSG_TOKEN=                ANTHROPIC_MAX_TOKENS=4096
ANTHROPIC_API_KEY=             LOOKBACK_SECONDS=3600
STATE_DIR=/data                PORT=3000
ALLOWED_CHATS=                 (vazio = todos)
ADMIN_NUMBERS=                 (vazio = todos são admin)

COOPANEST_LOGIN_URL=           COOPANEST_USER=
COOPANEST_CASES_URL=           COOPANEST_PASS=

CHAT_EDUARDO=                  CHAT_FERNANDA=          CHAT_ADMIN=
GOOGLE_SHEET_ID=               GOOGLE_SERVICE_ACCOUNT_JSON=
SYNC_INTERVAL_MINUTES=60       SYNC_ON_BOOT=true       SYNC_SECRET=
```

### Google Sheets

1. Google Cloud Console → novo projeto → ative a **Google Sheets API**
2. Crie uma **Service Account** → Keys → **Add key → JSON**
3. Cole o JSON inteiro (uma linha, ou o base64 dele) em `GOOGLE_SERVICE_ACCOUNT_JSON`
4. **Compartilhe a planilha com o e-mail da service account** (`...@....iam.gserviceaccount.com`) como **Editor** — sem isso dá 403
5. `GOOGLE_SHEET_ID` é o trecho da URL: `docs.google.com/spreadsheets/d/`**`ESTE_PEDAÇO`**`/edit`

As três abas (`Cirurgias`, `Salario Sara`, `Historico`) são criadas sozinhas na primeira execução.

### chatId dos grupos

`https://api.ultramsg.com/INSTANCE/chats?token=TOKEN` — o do grupo termina em `@g.us`.

---

## Ajustando os seletores do portal

O `config.json` traz seletores genéricos (`input[name='usuario']`, `input[type='password']`, `table`). Se o login falhar, veja o que o navegador está enxergando:

```bash
npm install && npx playwright install chromium
cp .env.example .env      # preencha COOPANEST_*
npm run scrape            # imprime o HTML/texto da página, não gasta IA
```

Depois ajuste `coopanest.selectors` no `config.json`. Dá para mudar em produção sem redeploy: o bot lê `/data/config.override.json` por cima do `config.json`.

---

## Testes

```bash
npm test          # 28 testes offline: parser, diff, salário, formatação, webhook
npm run test:e2e  # fluxo completo com portal/UltraMsg/Anthropic falsos
npm run check     # node --check em todos os arquivos
```

O `test:e2e` precisa de um Chromium. Se o do Playwright não estiver instalado, aponte para outro:

```bash
CHROMIUM_PATH=/caminho/para/chrome npm run test:e2e
```

---

## Detalhes que importam

- **Nada é reenviado à toa.** Cada cirurgia tem um ID estável (paciente + data + procedimento). O bot só avisa o que é novo ou mudou de verdade — comparando valores como número, então `4.200,00` e `4200` não contam como mudança.
- **Campo vazio não apaga dado.** Se uma leitura vier incompleta (portal fora do ar, tabela paginada), o valor anterior é preservado em vez de virar "mudou para vazio".
- **`/analisar` não perde nem repete mensagem.** O marcador de tempo é gravado *antes* da busca; mensagens que chegam durante a análise ficam para a próxima rodada.
- **Um `/analisar` por grupo de cada vez** (lock em memória, liberado no `finally` mesmo se der erro).
- **PDF acima de 10MB** é comprimido com Ghostscript antes de ir para o Claude. Se a URL devolver HTML em vez do arquivo, o bot avisa em vez de mandar lixo para a IA.
- **Arquivo rejeitado pela API** é descartado e a análise continua sem ele; no limite, roda só com o texto.
- **Sessão do portal** fica em `/data/coopanest-session.json`, então nem toda varredura precisa refazer login.
