# Financial Bot Control

Bot de WhatsApp para controle financeiro de anestesiologia. Recebe mensagens
via UltraMsg, usa Claude (`claude-sonnet-4-6`) para extrair dados estruturados
de procedimentos cirúrgicos e atualiza automaticamente uma planilha Google
Sheets com o fluxo de caixa mensal.

Os valores dos procedimentos são pré-configurados pelo admin e inseridos na
planilha internamente — **nunca aparecem nas respostas do WhatsApp**.

## Como funciona

1. Toda mensagem no grupo que não começa com `/` passa por `isMedicalRecord()`
   (heurística: 2+ sinais entre médico, hospital, procedimento e data).
2. Se parecer um registro, o Claude extrai `nome_anestesista`, `hospital`,
   `procedimento`, `cirurgiao`, `data` (convertida para DD/MM/YYYY) e `status`.
3. Se faltar campo obrigatório, o bot pergunta **apenas o que falta** e mescla
   a resposta ao registro parcial.
4. O valor é buscado internamente em `config.json` (match exato → parcial →
   valor padrão → em branco) e gravado na aba `Registros`.
5. As abas `Resumo_Mensal` e `MM_YYYY` (criada automaticamente por mês) são
   reconstruídas a cada registro.

## Variáveis de ambiente (Railway)

| Variável | Descrição |
|---|---|
| `ULTRAMSG_INSTANCE_ID` | ex.: `instance12345` |
| `ULTRAMSG_TOKEN` | token da instância UltraMsg |
| `ANTHROPIC_API_KEY` | chave da API Anthropic |
| `GOOGLE_SERVICE_ACCOUNT` | JSON completo da Service Account, em uma linha |
| `SPREADSHEET_ID` | ID da planilha (da URL) |
| `ALLOWED_CHATS` | IDs dos grupos autorizados, separados por vírgula; vazio = todos |
| `ADMIN_NUMBERS` | números admin, separados por vírgula |
| `PORT` | `3000` |

## Google Sheets — Service Account (uma vez só)

1. [console.cloud.google.com](https://console.cloud.google.com) → criar projeto (ex.: `financialbot`)
2. APIs e Serviços → ativar **Google Sheets API** e **Google Drive API**
3. IAM e Administrador → Contas de serviço → Criar (`financialbot-sa`)
4. Na conta criada → aba Chaves → Adicionar chave → JSON → baixar
5. Copie o `client_email` do JSON
6. Crie a planilha em [planilhas.google.com](https://planilhas.google.com) e
   **compartilhe com o `client_email` como Editor**
7. `SPREADSHEET_ID` = trecho da URL `docs.google.com/spreadsheets/d/[ID]/edit`
8. `GOOGLE_SERVICE_ACCOUNT` = conteúdo do JSON inteiro em uma linha

## Deploy no Railway

1. Novo projeto a partir deste diretório (`financialbot/`, usa o `Dockerfile`)
2. Adicione um **volume montado em `/data`** (estado persistente: config e pendências)
3. Configure as variáveis de ambiente acima
4. No painel UltraMsg: Webhook URL = `https://SEU-DOMINIO/webhook`,
   "Webhook Download Media" = ON

## Comandos

Consulta: `/relatorio`, `/mes MM/YYYY`, `/anestesista [nome]`, `/status`, `/ajuda`

Admin — valores: `/setvalor Procedimento; 2800`, `/delvalor Procedimento`,
`/valores`, `/setvalorpadrao 1500`

Admin — gestão: `/setprompt [texto]`, `/limparprompt`, `/resetar`

## Teste rápido

1. Envie no grupo: `Dr. Carlos - Hospital X - Colecistectomia - Dr. Pedro - hoje`
2. Confira a linha na aba `Registros` da planilha
3. `/setvalor Colecistectomia; 2800` e registre outro procedimento — o valor
   entra na planilha automaticamente
4. `/relatorio` — o WhatsApp mostra apenas contagens, sem valores
