/* Testes funcionais da API e das regras do jogo.  Uso: npm test */
const crypto = require('node:crypto');
const { executar } = require('./_base');

let ok = 0, falhas = [];
const t = (nome, cond, extra = '') => {
  if(cond){ ok++; console.log('  ✓', nome); }
  else { falhas.push(nome); console.log('  ✗', nome, extra); }
};
const grupo = n => console.log('\n' + n);

const q = (enun, correta = 0) => ({ enunciado:enun, alts:['a', 'b', 'c', 'd'], correta });
const cfg = (virada, extra = {}) => ({ config:{ total:1000000, tempo:90, pct:[100, 60, 30], virada, ...extra } });
const agora = ms => new Date(Date.now() + ms).toISOString();

executar(async ({ c, A, sql }) => {
  /* ------------------------------------------------------ */
  grupo('Páginas estáticas');
  for(const p of ['/', '/index.html', '/jogo.html', '/admin.html', '/estilo.css', '/common.js']){
    const r = await c.get(p); t(`GET ${p} → 200`, r.status === 200);
  }
  t('GET /index.html é HTML', (await c.get('/index.html')).tipo.includes('text/html'));
  t('arquivo fora da lista → 404 (server.js)', (await c.get('/server.js')).status === 404);
  t('travessia de diretório → 404', (await c.get('/../.env.local')).status === 404);
  t('.env.local não é servido', (await c.get('/.env.local')).status === 404);
  t('rota de API inexistente → 404', (await c.get('/api/nao-existe')).status === 404);

  /* ------------------------------------------------------ */
  grupo('Login / cadastro de jogador');
  let r = await c.post('/api/login', { matricula:'TST001' });
  t('matrícula nova sem nome → 404 pedindo nome', r.status === 404);
  r = await c.post('/api/login', { matricula:'tst001', nome:'Ana Teste' });
  t('cadastra e normaliza matrícula para maiúsculas', r.status === 200 && r.json.novo && r.json.jogador.matricula === 'TST001');
  r = await c.post('/api/login', { matricula:'TST001' });
  t('login seguinte reaproveita o cadastro', r.status === 200 && !r.json.novo && r.json.jogador.nome === 'Ana Teste');
  t('matrícula com espaços/minúsculas é a mesma', (await c.post('/api/login', { matricula:'  tst001 ' })).json.jogador.nome === 'Ana Teste');
  for(const m of ['', 'a b', 'x'.repeat(21), "A'; DROP TABLE jogadores;--", '<script>', 123, null]){
    t(`matrícula inválida rejeitada (${JSON.stringify(m).slice(0, 24)})`, (await c.post('/api/login', { matricula:m, nome:'x' })).status === 400);
  }
  t('nome com 25 caracteres rejeitado', (await c.post('/api/login', { matricula:'TST002', nome:'n'.repeat(25) })).status === 400);
  t('nome só com espaços → pede nome (404)', (await c.post('/api/login', { matricula:'TST002', nome:'   ' })).status === 404);
  r = await c.post('/api/login', { matricula:'TST003', nome:"x'; DROP TABLE j;--" });
  t('nome com SQL é guardado como texto', r.status === 200 && r.json.jogador.nome.includes('DROP TABLE'));
  t('tabela jogadores continua existindo', (await c.get('/api/ranking')).status === 200);
  t('JSON inválido → 400', (await c.bruto('/api/login', '{quebrado')).status === 400);
  r = await c.chamar('POST', '/api/login', undefined); t('corpo vazio → 400 (matrícula inválida)', r.status === 400);

  /* ------------------------------------------------------ */
  grupo('Estado do jogo e dias');
  r = await c.get('/api/estado');
  t('sem virada: dia 1 com 5 perguntas', r.status === 200 && r.json.dia === 1 && r.json.total === 5);
  t('estado não entrega perguntas nem respostas', !r.txt.includes('alts') && !r.txt.includes('correta') && !('perguntas' in r.json));
  t('config tem total/tempo/pct', r.json.config.total === 1000000 && r.json.config.tempo === 90 && r.json.config.pct.length === 3);

  t('admin: PUT perguntas dia 2', (await c.put('/api/perguntas', { dia:2, perguntas:[q('DIA2-A'), q('DIA2-B', 3)] }, A)).status === 200);
  r = await c.get('/api/estado');
  t('estado (dia 1) NÃO vaza perguntas do dia 2', !r.txt.includes('DIA2-'));
  t('gravar o dia 2 não alterou o dia 1', r.json.total === 5);

  await c.put('/api/config', cfg(agora(3600e3)), A);
  t('virada no futuro → ainda dia 1', (await c.get('/api/estado')).json.dia === 1);
  await c.put('/api/config', cfg(agora(-1000)), A);
  r = await c.get('/api/estado');
  t('virada passada → dia 2 com SÓ as perguntas do dia 2', r.json.dia === 2 && r.json.total === 2);
  t('resposta correta do dia 2 preservada (visão do admin)', (await c.get('/api/admin/perguntas', A)).json.perguntas[2][1].correta === 3);
  await c.put('/api/config', cfg(null), A);

  /* Partidas, limite por dia, desempate e virada: veja tests/regras.js */

  /* ------------------------------------------------------ */
  grupo('Autenticação do admin');
  const ruim = { usuario:'admin', senha:'errada' };
  t('senha errada → 401', (await c.post('/api/admin/login', ruim)).status === 401);
  t('usuário errado → 401', (await c.post('/api/admin/login', { usuario:'root', senha:'x' })).status === 401);
  t('login sem corpo → 401 (não 500)', (await c.post('/api/admin/login', {})).status === 401);
  t('login com tipos errados → 401 (não 500)', (await c.post('/api/admin/login', { usuario:{}, senha:[] })).status === 401);
  t('senha correta devolve token', !!A);
  t('sessão válida → 200', (await c.get('/api/admin/sessao', A)).status === 200);
  t('sem token → 401', (await c.get('/api/admin/sessao')).status === 401);
  t('token falso → 401', (await c.get('/api/admin/sessao', { Authorization:'Bearer abc.def' })).status === 401);
  const tok = A.Authorization.split(' ')[1].split('.');
  const forjado = Buffer.from(JSON.stringify({ exp:Date.now() + 9e9 })).toString('base64url') + '.' + tok[1];
  t('token com payload alterado (assinatura antiga) → 401', (await c.get('/api/admin/sessao', { Authorization:'Bearer ' + forjado })).status === 401);
  const expirado = Buffer.from(JSON.stringify({ exp:Date.now() - 1000 })).toString('base64url');
  t('token expirado → 401', (await c.get('/api/admin/sessao', { Authorization:`Bearer ${expirado}.${crypto.randomBytes(32).toString('base64url')}` })).status === 401);
  for(const [m, u, b] of [['PUT', '/api/perguntas', { dia:1, perguntas:[] }], ['PUT', '/api/config', cfg(null)], ['GET', '/api/admin/perguntas']]){
    t(`${m} ${u} sem login → 401`, (await c.chamar(m, u, b)).status === 401);
  }
  t('as 5 perguntas do dia 1 seguem intactas após as tentativas sem login', (await c.get('/api/estado')).json.total === 5);

  /* ------------------------------------------------------ */
  grupo('Admin: validação de perguntas e configuração');
  const ruins = [
    ['sem enunciado', { enunciado:'', alts:['a', 'b', 'c', 'd'], correta:0 }], ['3 alternativas', { enunciado:'x', alts:['a', 'b', 'c'], correta:0 }],
    ['alternativa vazia', { enunciado:'x', alts:['a', '', 'c', 'd'], correta:0 }], ['correta fora de 0-3', { enunciado:'x', alts:['a', 'b', 'c', 'd'], correta:4 }],
    ['correta como texto', { enunciado:'x', alts:['a', 'b', 'c', 'd'], correta:'0' }], ['enunciado > 300', { enunciado:'x'.repeat(301), alts:['a', 'b', 'c', 'd'], correta:0 }],
    ['alternativa > 120', { enunciado:'x', alts:['a'.repeat(121), 'b', 'c', 'd'], correta:0 }]
  ];
  for(const [n, p] of ruins) t(`rejeita pergunta ${n}`, (await c.put('/api/perguntas', { dia:1, perguntas:[p] }, A)).status === 400);
  t('rejeita > 200 perguntas', (await c.put('/api/perguntas', { dia:1, perguntas:Array(201).fill(q('x')) }, A)).status === 400);
  t('rejeita dia 3 / sem dia', (await c.put('/api/perguntas', { dia:3, perguntas:[] }, A)).status === 400 && (await c.put('/api/perguntas', { perguntas:[] }, A)).status === 400);
  t('perguntas inválidas não apagaram o dia 1', (await c.get('/api/estado')).json.total === 5);
  t('aceita dia vazio (limpar)', (await c.put('/api/perguntas', { dia:2, perguntas:[] }, A)).status === 200);
  await c.put('/api/perguntas', { dia:2, perguntas:[q('  espaço  ')] }, A);
  t('texto é aparado (trim)', (await c.get('/api/admin/perguntas', A)).json.perguntas[2][0].enunciado === 'espaço');
  r = await c.get('/api/admin/perguntas', A);
  t('admin vê os dois dias', r.json.perguntas[1].length === 5 && r.json.perguntas[2].length === 1);
  const cfgRuins = [['total 0', { total:0 }], ['total negativo', { total:-5 }], ['tempo 2', { tempo:2 }], ['tempo 601', { tempo:601 }],
    ['pct 101', { pct:[101, 60, 30] }], ['pct com 2 itens', { pct:[100, 60] }], ['virada inválida', { virada:'amanhã' }], ['virada numérica', { virada:123 }]];
  for(const [n, extra] of cfgRuins) t(`config rejeita ${n}`, (await c.put('/api/config', cfg(null, extra), A)).status === 400);
  t('virada é normalizada para ISO', (await c.put('/api/config', cfg('2030-05-01T12:00:00-03:00'), A)).status === 200 && (await c.get('/api/estado')).json.config.virada === '2030-05-01T15:00:00.000Z');
  await c.put('/api/config', cfg(null), A);

  console.log(`\n${ok} passaram, ${falhas.length} falharam`);
  if(falhas.length){ console.log('Falhas:\n - ' + falhas.join('\n - ')); process.exitCode = 1; }
}).then(c => { if(c) process.exitCode = c; });
