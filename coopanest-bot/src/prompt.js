import { getConfig } from './config.js';

const FIELD_HINTS = {
  paciente: 'nome do paciente como aparece na fonte',
  medico: 'anestesista responsavel (ex.: Dr. Eduardo, Dra. Fernanda)',
  procedimento: 'procedimento/cirurgia realizada',
  data: 'data da cirurgia em DD/MM/AAAA',
  hospital: 'hospital ou clinica',
  convenio: 'convenio/operadora (ex.: Unimed, Bradesco, particular)',
  status: 'situacao atual da conta, copiada literalmente da fonte',
  valorBruto: 'valor bruto do procedimento, apenas numero',
  valorPago: 'valor ja pago/creditado, apenas numero',
  valorReceber: 'valor ainda a receber, apenas numero',
  glosa: 'valor glosado, apenas numero (0 se nao houver)',
  recursoGlosa: 'situacao do recurso de glosa (ex.: "Em recurso", "Recurso deferido", "Sem recurso")',
  parceiro: 'equipe/cirurgiao parceiro do caso (ex.: DATBABY, Dr. Raphael Datrino, Dr. Thiago Dantas)',
  observacoes: 'qualquer informacao relevante que nao coube nos outros campos',
};

function fieldList(cfg) {
  return (cfg.fields || Object.keys(FIELD_HINTS))
    .map((field) => `- "${field}": ${FIELD_HINTS[field] || 'valor correspondente na fonte'}`)
    .join('\n');
}

function rulesBlock(cfg) {
  const rules = cfg.prompt?.rules || [];
  return rules.map((rule, index) => `${index + 1}. ${rule}`).join('\n');
}

function doctorsBlock(cfg) {
  return (cfg.doctors || [])
    .map((doctor) => `- ${doctor.name} (aliases: ${(doctor.aliases || []).join(', ') || doctor.id})`)
    .join('\n');
}

function partnersBlock(cfg) {
  return (cfg.salary?.partners || []).map((partner) => `- ${partner}`).join('\n');
}

/**
 * Monta o system prompt a partir do config.json.
 * @param {{mode?: 'extract'|'triage'}} options
 */
export function buildSystemPrompt({ mode = 'extract' } = {}) {
  const cfg = getConfig();
  const source =
    mode === 'triage'
      ? 'mensagens de um grupo de WhatsApp da equipe'
      : 'paginas do portal da Coopanest Rio (HTML/texto ja extraido do navegador)';

  return [
    cfg.prompt?.role || 'Voce e um assistente administrativo de uma equipe de anestesiologia.',
    '',
    `Sua tarefa: ler ${source} e devolver os dados estruturados de cada cirurgia/conta encontrada.`,
    '',
    'MEDICOS ACOMPANHADOS:',
    doctorsBlock(cfg) || '- (nenhum configurado)',
    '',
    'PARCEIROS QUE ENTRAM NO CALCULO DO SALARIO DA SARA:',
    partnersBlock(cfg) || '- (nenhum configurado)',
    'Se o caso pertencer a um desses parceiros, registre o nome dele no campo "parceiro".',
    '',
    'CAMPOS DE CADA CASO:',
    fieldList(cfg),
    '',
    'REGRAS:',
    rulesBlock(cfg),
    '',
    'FORMATO DA RESPOSTA:',
    'Responda APENAS com um array JSON, sem texto antes ou depois, no formato:',
    '[{"paciente":"","medico":"","procedimento":"","data":"","hospital":"","convenio":"","status":"","valorBruto":"","valorPago":"","valorReceber":"","glosa":"","recursoGlosa":"","parceiro":"","observacoes":""}]',
    'Se nenhuma cirurgia for encontrada, responda exatamente [].',
  ].join('\n');
}

/** Prompt do usuario para extracao a partir do portal. */
export function buildExtractionPrompt({ pageLabel = 'portal', content = '' }) {
  return [
    `Conteudo extraido de: ${pageLabel}`,
    '',
    '--- INICIO DO CONTEUDO ---',
    content,
    '--- FIM DO CONTEUDO ---',
    '',
    'Liste todas as cirurgias/contas presentes neste conteudo no formato JSON pedido.',
  ].join('\n');
}

/** Prompt do usuario para um caso vindo do grupo de WhatsApp. */
export function buildTriagePrompt({ caseText = '', mediaNote = '', doctorName = '' }) {
  return [
    doctorName ? `Grupo do(a) ${doctorName}.` : '',
    'Mensagens do grupo referentes a um caso:',
    '',
    '--- INICIO ---',
    caseText,
    '--- FIM ---',
    mediaNote ? `\n${mediaNote}` : '',
    '',
    'Extraia os dados deste caso no formato JSON pedido (array com um ou mais objetos).',
  ]
    .filter(Boolean)
    .join('\n');
}
