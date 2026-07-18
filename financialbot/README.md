# Financial Bot Control

Bot de WhatsApp para controle financeiro de anestesiologia. Recebe mensagens via
UltraMsg, usa Claude (Anthropic API) para extrair dados estruturados de
procedimentos cirúrgicos e atualiza automaticamente uma planilha Google Sheets
com o fluxo de caixa mensal.

Os valores dos procedimentos são pré-configurados pelo admin e inseridos na
planilha automaticamente — **nunca aparecem nas respostas do WhatsApp**.

## Como funciona

1. Toda mensagem do grupo que não começa com `/` passa por `isMedicalRecord()`.
2. Se parecer um registro (≥2 sinais entre médico, hospital, procedimento e data),
   o Claude extrai os campos estruturados.
3. O valor é buscado internamente em `config.json` pelo nome do procedimento
   (correspondência exata → parcial → valor padrão → em branco).
4. O registro entra na aba `Registros`; as abas `Resumo_Mensal` e `MM_YYYY`
   são recalculadas. Abas são criadas automaticamente se não existirem.
5. Se faltar campo obrigatório, o bot pergunta apenas o que falta.

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

1. Envie no grupo: `Dr. Carlos - Hospital X - Colecistectomia - Dr. Pedro - hoje`
2. Verifique a linha na aba `Registros`
3. Cadastre um valor: `/setvalor Colecistectomia; 2800`
4. Registre outro procedimento e confira o valor preenchido na planilha
5. Rode `/relatorio` — o WhatsApp mostra apenas contagens, sem valores

## Comandos

**Consulta:** `/relatorio`, `/mes MM/YYYY`, `/anestesista [nome]`, `/status`, `/ajuda`

**Admin (valores):** `/setvalor Proc; 2800`, `/delvalor Proc`, `/valores`, `/setvalorpadrao 1500`

**Admin (geral):** `/setprompt [texto]`, `/limparprompt`, `/resetar`
