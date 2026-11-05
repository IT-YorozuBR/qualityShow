/* Iniciar / encerrar o jogo, relatório (dashboard) e registro das respostas.  Uso: npm run test:jogo */
const { executar } = require('./_base');

let ok = 0, falhas = [];
const t = (nome, cond, extra = '') => {
  if(cond){ ok++; console.log('  ✓', nome); }
  else { falhas.push(nome); console.log('  ✗', nome, extra); }
};
const grupo = n => console.log('\n' + n);

executar(async ({ c, A, sql }) => {
  const corretas = (await sql`SELECT correta FROM perguntas WHERE dia=1 ORDER BY ordem`).map(r => r.correta);
  const dia = (await c.get('/api/estado')).json.dia;
  const jogar = async (mat, nome, acertos) => {      // acerta `acertos` perguntas e erra a seguinte
    await c.post('/api/login', { matricula:mat, nome });
    await c.post('/api/partida/iniciar', { matricula:mat, dia });
    for(let i = 0; i < corretas.length; i++){
      await c.post('/api/partida/proxima', { matricula:mat, dia });
      const alt = i < acertos ? corretas[i] : (corretas[i] + 1) % 4;
      await c.post('/api/partida/responder', { matricula:mat, dia, idx:i, alt });
      if(i >= acertos) break;
    }
  };

  grupo('Jogo aberto (estado dos testes)');
  t('/api/estado informa aberto', (await c.get('/api/estado')).json.estado === 'aberto');
  t('admin/jogo exige login', (await c.get('/api/admin/jogo')).status === 401);
  t('iniciar com o jogo já aberto → 409', (await c.post('/api/admin/jogo/iniciar', {}, A)).status === 409);

  await jogar('TST900', 'Ana', 3);
  await jogar('TST901', 'Bia', 1);
  const lib = await c.post('/api/login', { matricula:'TST900' });
  t('jogadas registradas em respostas', Number((await sql`SELECT COUNT(*)::int n FROM respostas WHERE matricula='TST900'`)[0].n) === 4);

  grupo('Encerrar');
  t('encerrar exige login', (await c.post('/api/admin/jogo/encerrar', {})).status === 401);
  let r = await c.post('/api/admin/jogo/encerrar', {}, A);
  t('encerrar → 200 com relatorioId', r.status === 200 && r.json.estado === 'encerrado' && r.json.relatorioId > 0, r.txt);
  const id = r.json.relatorioId;
  t('encerrar de novo → 409', (await c.post('/api/admin/jogo/encerrar', {}, A)).status === 409);

  grupo('Jogo fechado bloqueia os participantes');
  t('/api/estado informa encerrado', (await c.get('/api/estado')).json.estado === 'encerrado');
  for(const [n, u, b] of [['login', '/api/login', { matricula:'TST902', nome:'Cris' }], ['iniciar', '/api/partida/iniciar', { matricula:'TST900', dia }],
    ['proxima', '/api/partida/proxima', { matricula:'TST900', dia }], ['responder', '/api/partida/responder', { matricula:'TST900', dia, idx:0, alt:0 }]]){
    r = await c.post(u, b);
    t(`${n} → 423 FECHADO`, r.status === 423 && r.json.codigo === 'FECHADO' && r.json.estado === 'encerrado', r.txt);
  }
  t('placar continua público', (await c.get('/api/ranking')).status === 200);

  grupo('Relatório salvo');
  t('relatório exige login', (await c.get('/api/admin/relatorio?id=' + id)).status === 401);
  r = await c.get('/api/admin/relatorio?id=' + id, A);
  const d = r.json && r.json.dados;
  t('relatório salvo existe', r.status === 200 && !!d, r.txt);
  const rk = d.ranking.geral;
  t('ranking: Ana em 1º, Bia em 2º', rk[0].nome === 'Ana' && rk[1].nome === 'Bia' && rk[0].pontos > rk[1].pontos);
  t('resumo: 2 jogadores e 6 respostas (Ana 4, Bia 2)', d.resumo.geral.jogadores === 2 && d.resumo.geral.respostas === 6, JSON.stringify(d.resumo.geral));
  t('por pergunta: 1ª respondida 2×, acertada 2×', d.perguntas[dia][0].respondidas === 2 && d.perguntas[dia][0].acertos === 2);
  t('por pergunta: 2ª respondida 2×, acertada 1×', d.perguntas[dia][1].respondidas === 2 && d.perguntas[dia][1].acertos === 1);
  t('relatório fica salvo mesmo se a partida for liberada', (await c.post('/api/admin/liberar', { matricula:'TST901', dia }, A)).status === 200
    && (await c.get('/api/admin/relatorio?id=' + id, A)).json.dados.ranking.geral.length === 2);
  t('liberar remove as respostas da partida', Number((await sql`SELECT COUNT(*)::int n FROM respostas WHERE matricula='TST901'`)[0].n) === 0);
  t('relatório inexistente → 404', (await c.get('/api/admin/relatorio?id=999999', A)).status === 404);
  t('id inválido → 400', (await c.get('/api/admin/relatorio?id=abc', A)).status === 400);
  t('ao vivo funciona', (await c.get('/api/admin/relatorio?id=vivo', A)).json.dados.resumo.geral.jogadores === 1);
  r = await c.get('/api/admin/jogo', A);
  t('lista de relatórios traz o salvo', r.json.estado === 'encerrado' && r.json.relatorios.some(x => x.id === id));
  t('relatório manual', (await c.post('/api/admin/relatorios', {}, A)).status === 200);

  grupo('Iniciar de novo');
  r = await c.post('/api/admin/jogo/iniciar', {}, A);
  t('iniciar → 200 aberto, nova rodada', r.json.estado === 'aberto' && r.json.novaRodada === true, r.txt);
  t('placar zerado', (await c.get('/api/ranking')).json.jogadores.length === 0);
  t('quem já jogou pode jogar de novo', (await c.post('/api/partida/iniciar', { matricula:'TST900', dia })).status === 200);
  t('relatório da rodada anterior continua salvo', (await c.get('/api/admin/relatorio?id=' + id, A)).json.dados.ranking.geral.length === 2);
  t('login volta a funcionar', (await c.post('/api/login', { matricula:'TST900' })).status === 200);
  t('iniciar exige login', (await c.post('/api/admin/jogo/iniciar', {})).status === 401);

  await sql`DELETE FROM respostas WHERE matricula LIKE 'TST%'`;
  await sql`DELETE FROM partidas WHERE matricula LIKE 'TST%'`; await sql`DELETE FROM jogadores WHERE matricula LIKE 'TST%'`;
  console.log(`\n${ok} passaram, ${falhas.length} falharam`);
  if(falhas.length){ console.log('Falhas:\n - ' + falhas.join('\n - ')); process.exitCode = 1; }
}).then(c => { if(c) process.exitCode = c; });
