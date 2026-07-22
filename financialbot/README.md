# Financial Bot Control

Bot de WhatsApp para controle financeiro de anestesiologia. A secretária envia no
grupo: **paciente, data, valor e situação do pagamento** (pago 100%, glosa do
convênio ou pendente). O bot usa Claude (Anthropic API) para extrair os dados e
atualiza automaticamente uma planilha Google Sheets onde **cada paciente tem seu
próprio controle**.

## Roteamento por grupo

Um único número de WhatsApp (o do UltraMsg) fica em **dois grupos**:

- Grupo **"Controle Eduardo"** → registros vão para a planilha do Eduardo
- Grupo **"Controle Fernanda"** → registros vão para a planilha da Fernanda

**O grupo de onde a mensagem veio decide de quem é o registro** — a secretária não
precisa dizer nada, só postar no grupo certo. Cada grupo é mapeado por variáveis de
ambiente (veja abaixo). Mensagens de grupos não configurados são ignoradas.

## Como funciona

1. Toda mensagem do grupo que não começa com `/` passa por `isFinancialRecord()`.
2. O Claude extrai: paciente, data, valor, status de pagamento (`pago`/`glosado`/
   `pendente`), valor pago, glosa, procedimento, convênio e observações.
3. Em glosas, informando só o valor recebido OU só o valor glosado, o bot calcula
   a diferença automaticamente.
4. Mensagens como **"caiu o pagamento da Maria"** são entendidas como *atualização*:
   o bot localiza o registro em aberto mais recente do paciente e atualiza a planilha.
5. Se faltar campo obrigatório (paciente, data ou valor), o bot pergunta só o que falta.

Exemplos reconhecidos:

```
Maria Silva - 15/07 - R$3.000 - pago 100%
Paciente João Souza, ontem, 2.850, convênio glosou R$400
Ana Pereira / Unimed / hoje / 3200 / pendente
Caiu o pagamento da Maria Silva
```

## Comissão da secretária (Sara)

O bot calcula automaticamente o salário da Sara: **5% do líquido** das cirurgias
que ela autoriza, onde **líquido = bruto − 20% de imposto**.

Uma cirurgia "conta" para a Sara quando o **cirurgião** OU a **clínica** estão
cadastrados. Padrão: cirurgiões **Raphael Datrino** e **Gustavo Siqueira**, e
clínica **Clínica Dat Baby** (qualquer cirurgião nessa clínica conta). Para que o
bot reconheça, a secretária deve incluir o cirurgião ou a clínica na mensagem:

```
Maria Silva - 15/07 - R$10.000 - Dr. Raphael Datrino - pago
João - ontem - 8.000 - Clínica Dat Baby - Dr. Gustavo Siqueira - pago
```

Consulte com `/sara` (mês atual) ou `/sara MM/YYYY`. Quando entrar um novo
cirurgião ou clínica, adicione com `/addcirurgiao Nome` ou `/addclinica Nome`.

> A base de cálculo padrão é o **valor faturado (bruto)**. Se preferir calcular
> sobre o **valor recebido** (descontando glosas/pendências), mude `sara.basis`
> para `"recebido"` no `config.json`.

## Estrutura da planilha (de cada controle)

| Aba | Conteúdo |
|---|---|
| `Registros` | Dados brutos: Data, Paciente, Procedimento, Cirurgião, Clínica, Convênio, Valor, Valor Pago, Glosa, Status, Observações, Registrado_em, ID |
| `Resumo_Mensal` | Por mês: nº de registros, faturado, recebido, glosas, pendente |
| `Pacientes` | Visão geral: uma linha por paciente com totais e saldo pendente |
| `Comissao_Sara` | Comissão da Sara por mês (bruto, imposto, líquido, 5%) + lista das cirurgias que contam |
| `[Nome do Paciente]` | Aba individual criada automaticamente: histórico completo + linha TOTAL |

Todas as abas são criadas automaticamente e recalculadas a cada registro.

## Comandos

**Consulta:** `/relatorio`, `/mes MM/YYYY`, `/paciente [nome]`, `/pendentes`, `/sara [MM/YYYY]`, `/status`, `/id`, `/ajuda`

**Admin — comissão da Sara:** `/saraconfig`, `/addcirurgiao [nome]`, `/delcirurgiao [nome]`, `/addclinica [nome]`, `/delclinica [nome]`

**Admin — geral:** `/setprompt [texto]`, `/limparprompt`, `/resetar`

`/id` mostra o ID do grupo atual — use para descobrir os IDs na hora de configurar.

## Variáveis de ambiente (Railway)

| Variável | Descrição |
|---|---|
| `ULTRAMSG_INSTANCE_ID` | ex: `instance12345` |
| `ULTRAMSG_TOKEN` | token UltraMsg |
| `ANTHROPIC_API_KEY` | chave da Anthropic API |
| `GOOGLE_SERVICE_ACCOUNT` | JSON completo da Service Account, em uma linha |
| `GROUP_1_CHAT` | ID do grupo do Eduardo (ex: `1203...@g.us`) — descubra com `/id` |
| `GROUP_1_NAME` | `Eduardo` |
| `GROUP_1_SHEET` | ID da planilha do Eduardo |
| `GROUP_2_CHAT` | ID do grupo da Fernanda |
| `GROUP_2_NAME` | `Fernanda` |
| `GROUP_2_SHEET` | ID da planilha da Fernanda |
| `ADMIN_NUMBERS` | seu número (para comandos admin), ex: `5521999998888` |
| `SPREADSHEET_ID` | opcional — planilha padrão se um `GROUP_n_SHEET` ficar vazio |
| `PORT` | 3000 |
| `STATE_DIR` | opcional; padrão `/data` (volume Railway) |

> Se quiser uma planilha **única compartilhada** entre os dois controles em vez de
> duas separadas, deixe `GROUP_1_SHEET`/`GROUP_2_SHEET` vazios e defina só
> `SPREADSHEET_ID`. (Nesse caso os dois grupos gravam na mesma planilha.)

---

# Passo a passo para colocar no ar

Você já tem: API da Anthropic, UltraMsg (número) e Railway. Falta configurar o
Google Sheets e amarrar tudo. São ~20 minutos.

## 1. Google Cloud — Service Account (uma vez só)

1. Acesse [console.cloud.google.com](https://console.cloud.google.com) e crie um projeto (ex: "financialbot").
2. **APIs e Serviços → Biblioteca** → ative **Google Sheets API** e **Google Drive API**.
3. **IAM e Administrador → Contas de serviço → Criar conta de serviço**. Nome: `financialbot-sa` → Criar → Concluir.
4. Clique na conta criada → aba **Chaves → Adicionar chave → Criar nova chave → JSON**. Baixe o arquivo.
5. Abra o JSON e copie o valor de **`client_email`** (algo como `financialbot-sa@...iam.gserviceaccount.com`).

## 2. Criar as planilhas

Você quer **dois controles separados** → crie **duas planilhas** (uma sua, uma da Fernanda):

1. Em [planilhas.google.com](https://planilhas.google.com), crie a planilha **"Controle Eduardo"** (pode deixar vazia — o bot cria as abas sozinho).
2. **Compartilhe** com o `client_email` do passo 1, como **Editor**.
3. Copie o ID da URL: `docs.google.com/spreadsheets/d/`**`[ESTE-É-O-ID]`**`/edit` → esse é o `GROUP_1_SHEET`.
4. Repita para a planilha **"Controle Fernanda"** → esse ID é o `GROUP_2_SHEET`.
5. Compartilhe a planilha da Fernanda também com ela (com a conta Google dela), assim ela acessa o controle dela.

## 3. Criar os dois grupos de WhatsApp

1. No WhatsApp do número que está no UltraMsg, crie o grupo **"Controle Eduardo"** e adicione a secretária.
2. Crie o grupo **"Controle Fernanda"** e adicione a secretária.
3. (Os IDs dos grupos você pega no passo 6, depois do deploy.)

## 4. Deploy no Railway

1. Novo projeto a partir deste repositório, apontando para a pasta `financialbot/` (o Dockerfile já está aqui).
2. Em **Settings → Volumes**, adicione um volume montado em **`/data`** (estado persistente).
3. Em **Variables**, configure — por enquanto, sem os `GROUP_*_CHAT` (vamos pegá-los no passo 6):
   - `ULTRAMSG_INSTANCE_ID`, `ULTRAMSG_TOKEN`
   - `ANTHROPIC_API_KEY`
   - `GOOGLE_SERVICE_ACCOUNT` = **todo o conteúdo do JSON em uma única linha**
   - `GROUP_1_NAME=Eduardo`, `GROUP_1_SHEET=<id da sua planilha>`
   - `GROUP_2_NAME=Fernanda`, `GROUP_2_SHEET=<id da planilha dela>`
   - `ADMIN_NUMBERS=<seu número com DDI e DDD, só dígitos>`
4. Faça o deploy e copie o **domínio público** que o Railway gera (ex: `https://financialbot-production.up.railway.app`).

## 5. Configurar o webhook no UltraMsg

1. No painel do UltraMsg → **Instance settings → Webhooks**.
2. **Webhook URL** = `https://SEU-DOMINIO.up.railway.app/webhook`
3. Ligue **On Received** (mensagens recebidas) e **Webhook Download Media: ON**.

## 6. Descobrir e configurar os IDs dos grupos

1. No grupo **"Controle Eduardo"**, envie `/id`. O bot responde com o ID (algo como `1203...@g.us`).
2. No Railway, defina `GROUP_1_CHAT=<esse ID>`.
3. No grupo **"Controle Fernanda"**, envie `/id` e defina `GROUP_2_CHAT=<esse ID>`.
4. O Railway reinicia sozinho a cada mudança de variável. Nos logs você verá:
   `grupo "Eduardo" → 1203...@g.us → planilha ...`

## 7. Testar

1. No grupo do Eduardo, envie: `Maria Silva - hoje - R$3.000 - pendente`.
   - O bot responde `✅ Registro salvo — Eduardo` e cria a linha na **sua** planilha (aba `Registros` + aba `Maria Silva`).
2. Envie: `convênio pagou a Maria Silva com glosa de R$400`.
   - O bot atualiza: recebido R$2.600, glosa R$400.
3. Rode `/relatorio` e `/pendentes`.
4. Repita um teste no grupo da Fernanda e confirme que caiu **na planilha dela**, não na sua.

Pronto. Daí é só a secretária ir postando nos grupos.
