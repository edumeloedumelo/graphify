# Financial Bot Control

Bot de WhatsApp para controle financeiro de anestesiologia — fluxo da secretária.
Ela envia no grupo: **paciente, data, valor e situação do pagamento** (pago 100%,
glosa do convênio ou pendente). O bot usa Claude (Anthropic API) para extrair os
dados e atualiza automaticamente uma planilha Google Sheets onde **cada paciente
tem seu próprio controle**.

## Como funciona

1. Toda mensagem do grupo que não começa com `/` passa por `isFinancialRecord()`
   (≥2 sinais entre paciente, valor, data e termo de pagamento).
2. O Claude extrai os campos estruturados: paciente, data, valor, status de
   pagamento (`pago` / `glosado` / `pendente`), valor pago, glosa, procedimento,
   convênio e observações.
3. Em glosas, informando só o valor recebido OU só o valor glosado, o bot
   calcula a diferença automaticamente.
4. Mensagens do tipo **"caiu o pagamento da Maria"** são entendidas como
   *atualização*: o bot localiza o registro em aberto mais recente do paciente
   e atualiza a situação na planilha.
5. Se faltar campo obrigatório (paciente, data ou valor), o bot pergunta apenas
   o que falta.

Exemplos de mensagens reconhecidas:

```
Maria Silva - 15/07 - R$3.000 - pago 100%
Paciente João Souza, ontem, 2.850, convênio glosou R$400
Ana Pereira / Unimed / hoje / 3200 / pendente
Caiu o pagamento da Maria Silva
```

## Estrutura da planilha

| Aba | Conteúdo |
|---|---|
| `Registros` | Dados brutos: Data, Paciente, Procedimento, Convênio, Valor, Valor Pago, Glosa, Status, Observações, Registrado_em, ID |
| `Resumo_Mensal` | Por mês: nº de registros, faturado, recebido, glosas, pendente |
| `Pacientes` | Visão geral: uma linha por paciente com totais e saldo pendente |
| `[Nome do Paciente]` | Aba individual criada automaticamente: histórico completo + linha TOTAL |

Todas as abas são criadas automaticamente e recalculadas a cada registro.

## Comandos

**Consulta:** `/relatorio`, `/mes MM/YYYY`, `/paciente [nome]`, `/pendentes`, `/status`, `/ajuda`

**Admin:** `/setprompt [texto]`, `/limparprompt`, `/resetar`

## Variáveis de ambiente (Railway)

| Variável | Descrição |
|---|---|
| `ULTRAMSG_INSTANCE_ID` | ex: `instance12345` |
| `ULTRAMSG_TOKEN` | token UltraMsg |
| `ANTHROPIC_API_KEY` | chave da Anthropic API |
| `GOOGLE_SERVICE_ACCOUNT` | JSON completo da Service Account, em uma linha |
| `SPREADSHEET_ID` | ID da planilha (da URL) |
| `ALLOWED_CHATS` | IDs dos grupos autorizados, separados por vírgula (vazio = todos) |
| `ADMIN_NUMBERS` | números admin, separados por vírgula |
| `PORT` | 3000 |
| `STATE_DIR` | opcional; padrão `/data` (volume Railway) |

## Google Sheets — Service Account (uma vez só)

1. [console.cloud.google.com](https://console.cloud.google.com) → criar projeto (ex: "financialbot")
2. APIs e Serviços → Ativar APIs → **Google Sheets API** e **Google Drive API**
3. IAM e Administrador → Contas de serviço → Criar conta de serviço (`financialbot-sa`)
4. Na conta criada → aba Chaves → Adicionar chave → JSON → baixar
5. Copie o `client_email` do JSON
6. Crie a planilha em [planilhas.google.com](https://planilhas.google.com) e
   **compartilhe com o `client_email` como Editor**
7. Copie o ID da URL: `docs.google.com/spreadsheets/d/[ESTE-É-O-ID]/edit`
8. Configure `SPREADSHEET_ID` e `GOOGLE_SERVICE_ACCOUNT` (JSON inteiro em uma linha)

## Deploy no Railway

1. Novo projeto a partir deste repositório (diretório `financialbot/`, Dockerfile incluso)
2. Adicione um **volume montado em `/data`** (estado persistente)
3. Configure as variáveis de ambiente acima
4. No UltraMsg: Webhook URL = `https://SEU-DOMINIO/webhook`, Webhook Download Media: ON

## Teste

1. Envie no grupo: `Maria Silva - hoje - R$3.000 - pendente`
2. Verifique a linha na aba `Registros` e a aba individual `Maria Silva`
3. Envie: `convênio pagou a Maria Silva com glosa de R$400`
4. Confira a atualização (recebido R$2.600, glosa R$400) na planilha
5. Rode `/relatorio` e `/pendentes`
