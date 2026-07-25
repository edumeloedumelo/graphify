import { getConfig } from './config.js';

const FIELD_HINTS = {
  paciente: 'nome do paciente como aparece na página',
  medico: 'anestesista responsável (ex.: Dr. Eduardo, Dra. Fernanda)',
  procedimento: 'procedimento/cirurgia realizada',
  data: 'data da cirurgia em DD/MM/AAAA',
  hospital: 'hospital ou clínica',
  convenio: 'convênio/operadora (ex.: Unimed, Bradesco, particular)',
  status: 'situação atual da conta, copiada literalmente da página',
  valorBruto: 'valor bruto do procedimento, apenas número',
  valorPago: 'valor já pago/creditado, apenas número',
  valorReceber: 'valor ainda a receber, apenas número',
  glosa: 'valor glosado, apenas número (0 se não houver)',
  recursoGlosa: 'situação do recurso de glosa (ex.: "Em recurso", "Recurso deferido", "Sem recurso")',
  parceiro: 'equipe/cirurgião parceiro do caso (ex.: DATBABY, Dr. Raphael Datrino, Dr. Thiago Dantas)',
  observacoes: 'qualquer informação relevante que não coube nos outros campos',
};

function fieldList(cfg) {
  return (cfg.fields || Object.keys(FIELD_HINTS))
    .map((field) => `- "${field}": ${FIELD_HINTS[field] || 'valor correspondente na página'}`)
    .join('\n');
}

function doctorsBlock(cfg) {
  return (cfg.doctors || [])
    .map((doctor) => `- ${doctor.name} (também aparece como: ${(doctor.aliases || []).join(', ') || doctor.id})`)
    .join('\n');
}

function partnersBlock(cfg) {
  return (cfg.salary?.partners || []).map((partner) => `- ${partner}`).join('\n');
}

/** Monta o system prompt a partir do config.json. */
export function buildSystemPrompt() {
  const cfg = getConfig();

  return [
    cfg.prompt?.role || 'Você é um assistente administrativo de uma equipe de anestesiologia.',
    '',
    'Sua tarefa: ler o conteúdo de páginas do portal da Coopanest Rio (tabelas e texto já',
    'extraídos do navegador) e devolver os dados estruturados de cada cirurgia/conta encontrada.',
    '',
    'MÉDICOS ACOMPANHADOS:',
    doctorsBlock(cfg) || '- (nenhum configurado)',
    '',
    'PARCEIROS QUE ENTRAM NO CÁLCULO DO SALÁRIO:',
    partnersBlock(cfg) || '- (nenhum configurado)',
    'Se o caso pertencer a um desses parceiros, registre o nome dele no campo "parceiro".',
    '',
    'CAMPOS DE CADA CASO:',
    fieldList(cfg),
    '',
    'REGRAS:',
    (cfg.prompt?.rules || []).map((rule, index) => `${index + 1}. ${rule}`).join('\n'),
    '',
    'FORMATO DA RESPOSTA:',
    'Responda APENAS com um array JSON, sem texto antes ou depois, no formato:',
    '[{"paciente":"","medico":"","procedimento":"","data":"","hospital":"","convenio":"","status":"","valorBruto":"","valorPago":"","valorReceber":"","glosa":"","recursoGlosa":"","parceiro":"","observacoes":""}]',
    'Se a página não tiver nenhuma cirurgia (menu, ajuda, tela de erro), responda exatamente [].',
  ].join('\n');
}

/** Prompt do usuário para uma página do portal. */
export function buildExtractionPrompt({ pageLabel = 'portal', content = '' }) {
  return [
    `Conteúdo extraído de: ${pageLabel}`,
    '',
    '--- INÍCIO DO CONTEÚDO ---',
    content,
    '--- FIM DO CONTEÚDO ---',
    '',
    'Liste todas as cirurgias/contas presentes neste conteúdo no formato JSON pedido.',
    'Não invente linhas: se esta página não for uma listagem de cirurgias, responda [].',
  ].join('\n');
}
