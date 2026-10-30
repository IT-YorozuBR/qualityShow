/* Carrega perguntas de exemplo (setor de qualidade industrial) nos dois dias.
   Substitui as perguntas existentes de cada dia.  Uso: node scripts/carregar-perguntas-exemplo.js */
const path = require('node:path');
try { process.loadEnvFile(path.join(__dirname, '..', '.env.local')); } catch {}
const { neon } = require('@neondatabase/serverless');
const sql = neon(process.env.DATABASE_URL);

const DIA1 = [
  { enunciado:'O Diagrama de Ishikawa, também chamado de "espinha de peixe", é usado principalmente para quê?',
    alts:['Controlar o estoque de matéria-prima', 'Calcular o custo de produção', 'Definir o preço de venda', 'Levantar as possíveis causas de um problema'], correta:3 },
  { enunciado:'O que significa a sigla PDCA, ciclo muito usado na melhoria contínua?',
    alts:['Produzir, Distribuir, Controlar, Avaliar', 'Prevenir, Detectar, Corrigir, Auditar', 'Planejar, Fazer, Verificar, Agir', 'Programar, Documentar, Conferir, Arquivar'], correta:2 },
  { enunciado:'Qual norma internacional estabelece os requisitos para um Sistema de Gestão da Qualidade?',
    alts:['ISO 14001', 'ISO 9001', 'ISO 45001', 'ISO 27001'], correta:1 },
  { enunciado:'Na gestão da qualidade, o que é uma "não conformidade"?',
    alts:['O não atendimento a um requisito especificado', 'Um produto entregue antes do prazo', 'Uma reunião de equipe cancelada', 'Um equipamento novo na linha'], correta:0 },
  { enunciado:'A técnica dos "5 Porquês" tem como objetivo principal:',
    alts:['Treinar novos operadores', 'Chegar à causa raiz de um problema', 'Medir a satisfação do cliente', 'Reduzir o tempo de setup'], correta:1 }
];

const DIA2 = [
  { enunciado:'No programa 5S, o "Seiso" corresponde a qual senso?',
    alts:['Senso de utilização', 'Senso de disciplina', 'Senso de limpeza', 'Senso de organização'], correta:2 },
  { enunciado:'Qual ferramenta ordena as causas de um problema da maior para a menor frequência, destacando os "poucos vitais"?',
    alts:['Histograma', 'Fluxograma', 'Gráfico de dispersão', 'Diagrama de Pareto'], correta:3 },
  { enunciado:'No Controle Estatístico de Processo (CEP), um ponto fora dos limites de controle indica:',
    alts:['Uma possível causa especial de variação', 'Que o processo está perfeito', 'Que o instrumento de medição é novo', 'Que o lote deve ser aprovado direto'], correta:0 },
  { enunciado:'O que é uma ação corretiva?',
    alts:['Um treinamento de integração', 'Uma ação para prevenir um problema que ainda não ocorreu', 'Uma ação para eliminar a causa de uma não conformidade e evitar que se repita', 'A troca de fornecedor sem análise'], correta:2 },
  { enunciado:'Para que serve a calibração de um instrumento de medição?',
    alts:['Aumentar a velocidade da linha', 'Comparar suas medidas com um padrão rastreável e verificar sua exatidão', 'Reduzir o consumo de energia', 'Trocar o operador do posto'], correta:1 }
];

const gravar = (lista, dia) => sql.transaction([
  sql`DELETE FROM perguntas WHERE dia = ${dia}`,
  ...lista.map((p, i) => sql`INSERT INTO perguntas(ordem, enunciado, alts, correta, dia) VALUES(${i}, ${p.enunciado}, ${JSON.stringify(p.alts)}, ${p.correta}, ${dia})`)
]);

(async () => {
  await gravar(DIA1, 1);
  await gravar(DIA2, 2);
  const [r] = await sql`SELECT COUNT(*) FILTER (WHERE dia=1)::int AS d1, COUNT(*) FILTER (WHERE dia=2)::int AS d2 FROM perguntas`;
  console.log(`Perguntas carregadas: dia 1 = ${r.d1}, dia 2 = ${r.d2}`);
})().catch(e => { console.error(e.message); process.exit(1); });
