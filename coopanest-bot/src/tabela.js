/**
 * Leitura direta das tabelas da página, sem IA.
 *
 * A listagem do portal é uma <table> com cabeçalho estável
 * ("CPSA | Status | Paciente | Data Cirurgia | Valor Faturado | ..."), então
 * mandar o texto para o Claude interpretar era caro, lento e perdia linhas.
 * Aqui as colunas são casadas pelo nome do cabeçalho — tolerante a acento,
 * caixa e espaço — e cada linha vira um caso pronto.
 *
 * O Claude continua no fluxo, mas só para páginas que não são tabelas.
 */
import { normalize, toNumber, formatDate } from './format.js';

/** Cabeçalho do portal → campo do caso. A chave é o cabeçalho normalizado. */
const COLUNAS = {
  cpsa: 'guia',
  guia: 'guia',
  'n guia': 'guia',
  numero: 'guia',
  protocolo: 'guia',
  status: 'status',
  situacao: 'status',
  paciente: 'paciente',
  beneficiario: 'paciente',
  'data cirurgia': 'data',
  'data da cirurgia': 'data',
  data: 'data',
  'data atendimento': 'data',
  procedimento: 'procedimento',
  cirurgia: 'procedimento',
  hospital: 'hospital',
  local: 'hospital',
  origem: 'hospital',
  convenio: 'convenio',
  operadora: 'convenio',
  'valor faturado': 'valorBruto',
  'valor bruto': 'valorBruto',
  valor: 'valorBruto',
  'valor recebido': 'valorPago',
  'valor pago': 'valorPago',
  'valor glosado': 'glosa',
  glosa: 'glosa',
  'receber como': 'recebeComo',
  cirurgiao: 'cirurgiao',
  equipe: 'parceiro',
  medico: 'medico',
  anestesista: 'medico',
};

const MOEDA = ['valorBruto', 'valorPago', 'glosa'];

/** Lê todas as tabelas da página e devolve as linhas já casadas com o cabeçalho. */
export async function extractTableRows(page) {
  return page.evaluate(() => {
    const limpar = (texto) => (texto || '').replace(/\s+/g, ' ').trim();

    return [...document.querySelectorAll('table')]
      .map((tabela) => {
        const cabecalhos = [...tabela.querySelectorAll('thead th, thead td')].map((celula) => limpar(celula.innerText));
        // sem <thead>, tenta a primeira linha do corpo
        const primeiraLinha = tabela.querySelector('tr');
        const titulos = cabecalhos.length
          ? cabecalhos
          : [...(primeiraLinha?.querySelectorAll('th') || [])].map((celula) => limpar(celula.innerText));

        const linhas = [...tabela.querySelectorAll('tbody tr')]
          .map((linha) => {
            const celulas = [...linha.querySelectorAll('td')];
            if (celulas.length === 0) return null;
            const valores = celulas.map((celula) => limpar(celula.innerText));
            const link = linha.querySelector('a[href]');
            return { valores, href: link ? link.getAttribute('href') : '' };
          })
          .filter(Boolean);

        return { titulos, linhas };
      })
      .filter((tabela) => tabela.titulos.length > 0 && tabela.linhas.length > 0);
  });
}

/**
 * Converte as linhas cruas em casos, casando cada coluna pelo cabeçalho.
 * Devolve `null` para tabelas cujo cabeçalho não é reconhecido — assim o
 * chamador sabe que precisa cair no Claude em vez de gravar lixo.
 */
export function linhasParaCasos(tabela, mapa = COLUNAS) {
  const campos = tabela.titulos.map((titulo) => mapa[normalize(titulo)] || '');
  const reconhecidas = campos.filter(Boolean).length;

  // uma listagem de cirurgia tem, no mínimo, paciente ou guia + algo de data/valor
  const temIdentidade = campos.includes('paciente') || campos.includes('guia');
  const temDado = campos.includes('data') || campos.includes('valorBruto') || campos.includes('status');
  if (!temIdentidade || !temDado || reconhecidas < 3) return null;

  return tabela.linhas
    .map(({ valores, href }) => {
      const caso = { origemLeitura: 'tabela' };
      campos.forEach((campo, indice) => {
        if (!campo) return;
        const bruto = valores[indice];
        if (bruto === undefined || bruto === '') return;
        caso[campo] = bruto;
      });

      if (caso.data) caso.data = formatDate(caso.data);
      for (const campo of MOEDA) {
        if (caso[campo] === undefined) continue;
        const numero = toNumber(caso[campo]);
        caso[campo] = numero === null ? '' : numero;
      }
      if (caso.status) caso.statusOriginal = caso.status;
      if (href) caso.url = href;

      return caso;
    })
    .filter((caso) => caso.paciente || caso.guia);
}

/** Lê a página inteira: devolve os casos de todas as tabelas reconhecidas. */
export async function casosDaPagina(page, mapa) {
  const tabelas = await extractTableRows(page);
  const casos = [];
  let reconhecidas = 0;

  for (const tabela of tabelas) {
    const doTabela = linhasParaCasos(tabela, mapa);
    if (!doTabela) continue;
    reconhecidas += 1;
    casos.push(...doTabela);
  }

  return { casos, tabelas: tabelas.length, reconhecidas };
}

export { COLUNAS };
