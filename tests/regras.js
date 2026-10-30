/* Regras do jogo conduzido pelo servidor: limite de 1 partida por dia, pontuação pelo relógio do servidor,
   tentativas de fraude, desempate e virada do dia.
   Usa só dados TST* e restaura a config ao fim (não apaga as outras tabelas).  Uso: npm run test:regras */
const path = require('node:path');
const fs = require('node:fs');
const vm = require('node:vm');
const R = path.join(__dirname, '..') + path.sep;
const { tokenAdmin, subirServidor, iniciarBanco, abrirJogo, sql } = require('./_base.js');
const { valorEm } = require('../lib/app.js');
let ok = 0, ruins = [];
const t = (n, c, x = '') => { c ? ok++ : ruins.push(n + ' ' + x); console.log(c ? '  ✓' : '  ✗', n, c ? '' : x); };
(async () => {
  const porta = 3900 + Math.floor(Math.random() * 90), B = `http://localhost:${porta}`;
  await iniciarBanco();
  const estadoAntes = (await sql`SELECT valor FROM config WHERE chave='estado'`)[0];
  await abrirJogo();
  const proc = await subirServidor(porta);
  const call = async (m, u, b, h = {}) => { const r = await fetch(B + u, { method:m, headers:{ 'Content-Type':'application/json', ...h }, body:b && JSON.stringify(b) }); const txt = await r.text(); let j = null; try { j = JSON.parse(txt); } catch {} return { s:r.status, j, txt }; };
  const cfgAntes = (await sql`SELECT valor FROM config WHERE chave='jogo'`)[0].valor;
  const cfg = JSON.parse(cfgAntes);
  const c = { get:(u, h) => call('GET', u, undefined, h), post:(u, b, h) => call('POST', u, b, h) };
  const A = await tokenAdmin({ post:async (u, b) => { const r = await call('POST', u, b); return { json:r.j }; } });
  const putCfg = v => fetch(B + '/api/config', { method:'PUT', headers:{ 'Content-Type':'application/json', ...A }, body:JSON.stringify({ config:{ ...cfg, virada:v } }) });

  const corretas = (await sql`SELECT correta FROM perguntas WHERE dia=1 ORDER BY ordem`).map(r => r.correta);
  const n = corretas.length, maxPorPergunta = Math.round(cfg.total / n);
  if(n < 3) throw new Error('Os testes precisam de pelo menos 3 perguntas no dia 1.');

  const entrar = (m, nome = m) => c.post('/api/login', { matricula:m, nome });
  const iniciar = (m, dia = 1) => c.post('/api/partida/iniciar', { matricula:m, dia });
  const resp = (m, idx, alt, dia = 1, extra = {}) => c.post('/api/partida/responder', { matricula:m, dia, idx, alt, ...extra });
  const prox = (m, dia = 1) => c.post('/api/partida/proxima', { matricula:m, dia });
  const certa = (m, idx) => resp(m, idx, corretas[idx]);
  /* faz o relógio do servidor achar que a pergunta atual foi entregue há `seg` segundos */
  const recuar = (m, seg, dia = 1) => sql`UPDATE partidas SET pergunta_inicio = now() - make_interval(secs => ${seg}::float8) WHERE matricula=${m} AND dia=${dia}`;
  const linha = async m => (await sql`SELECT pontos::int p, acertos, total, idx, finalizada, tempo_ms::int tempo, pergunta_inicio FROM partidas WHERE matricula=${m} AND dia=1`)[0];

  /* o dia 2 precisa ter perguntas (num banco novo não tem): cria as do teste e remove no fim */
  const [{ n:nDia2 }] = await sql`SELECT COUNT(*)::int AS n FROM perguntas WHERE dia=2`;
  if(!nDia2) await sql`INSERT INTO perguntas(ordem, enunciado, alts, correta, dia) VALUES(0, 'TST dia 2', '["a","b","c","d"]', 0, 2)`;
  try {
    await putCfg(null);

    console.log('Pontuação: fórmula do servidor = fórmula mostrada na tela (public/common.js)');
    const ctx = vm.createContext({});
    vm.runInContext(fs.readFileSync(path.join(R, 'public', 'common.js'), 'utf8'), ctx);
    vm.runInContext(`totalPerguntas = ${n}; config.total = ${cfg.total}; config.pct = ${JSON.stringify(cfg.pct)};`, ctx);
    let difere = 0;
    for(let i = 0; i <= 1000; i++) if(vm.runInContext(`valorEm(${i / 1000})`, ctx) !== valorEm(cfg, n, i / 1000)) difere++;
    t('valorEm igual em 1001 pontos do tempo', difere === 0, difere + ' diferenças');

    console.log('\nLimite de 1 partida por dia');
    let r = await entrar('TST100', 'Um');
    t('login: dia 1, ainda não jogou', r.j.dia === 1 && r.j.jogou === false);
    r = await iniciar('TST100');
    const ini100 = r;
    t('iniciar → 200 com o total, SEM pergunta e sem ligar o relógio', r.s === 200 && r.j.total === n && !('pergunta' in r.j) && (await linha('TST100')).pergunta_inicio === null, JSON.stringify(r.j));
    r = await iniciar('TST100');
    t('iniciar de novo (recarregar a página) → 409', r.s === 409 && /já jogou/.test(r.j.erro), JSON.stringify(r));
    t('login agora mostra jogou=true', (await c.post('/api/login', { matricula:'TST100' })).j.jogou === true);
    t('iniciar dia errado → 409', (await iniciar('TST100', 2)).s === 409);
    t('iniciar matrícula inexistente → 404', (await iniciar('TSTNADA')).s === 404);

    console.log('\nO servidor não entrega a resposta certa antes da hora');
    const est = await c.get('/api/estado');
    t('/api/estado traz só dia, total e config (sem perguntas)', est.s === 200 && est.j.total === n && !est.txt.includes('alts') && !est.txt.includes('correta'), est.txt.slice(0, 120));
    t('resposta de iniciar não contém "correta"', !ini100.txt.includes('correta'), ini100.txt.slice(0, 200));
    t('a rota antiga que aceitava pontos do navegador não existe mais', (await c.post('/api/partida', { matricula:'TST100', dia:1, pontos:999999, acertos:5, total:5 })).s === 404);

    console.log('\nResponder: o servidor mede o tempo e calcula os pontos');
    t('responder pergunta fora de ordem → 409', (await resp('TST100', 1, 0)).s === 409);
    t('responder sem ter iniciado → 409', (await entrar('TST101', 'Dois'), (await resp('TST101', 0, 0)).s === 409));
    t('responder antes de a pergunta ser aberta (relógio desligado) → 409', (await resp('TST100', 0, corretas[0])).s === 409);
    r = await prox('TST100');
    t('proxima (fim da animação) entrega a 1ª pergunta sem a resposta certa e liga o relógio', r.s === 200 && r.j.idx === 0 && !!r.j.pergunta.enunciado && r.j.pergunta.alts.length === 4 && !r.txt.includes('correta') && (await linha('TST100')).pergunta_inicio !== null, r.txt.slice(0, 150));
    t('responder com alternativa inválida → 400', (await resp('TST100', 0, 7)).s === 400);
    r = await resp('TST100', 0, corretas[0], 1, { pontos:9999999, tempoMs:1, acertos:99 });   // campos de pontos mandados pelo "jogador" são ignorados
    t('resposta certa → acertou, devolve a correta', r.s === 200 && r.j.acertou === true && r.j.correta === corretas[0] && r.j.fim === (n === 1), JSON.stringify(r.j));
    t('pontos calculados pelo servidor (perto do máximo, não os 9.999.999 enviados)', r.j.pontos > maxPorPergunta * .8 && r.j.pontos <= maxPorPergunta, String(r.j.pontos));
    t('responder a mesma pergunta de novo → 409 (não soma duas vezes)', (await resp('TST100', 0, corretas[0])).s === 409);
    t('responder a próxima sem pedi-la → 409 (relógio parado)', (await resp('TST100', 1, corretas[1])).s === 409);
    const antes = await linha('TST100');
    t('relógio da pergunta fica parado entre as perguntas', antes.pergunta_inicio === null && antes.idx === 1);
    r = await prox('TST100');
    t('proxima entrega a pergunta 2 sem a resposta certa', r.s === 200 && r.j.idx === 1 && !JSON.stringify(r.j).includes('correta'), JSON.stringify(r.j));
    const ini1 = (await linha('TST100')).pergunta_inicio;
    await new Promise(x => setTimeout(x, 300));
    r = await prox('TST100');
    t('proxima repetida devolve a mesma pergunta sem reiniciar o relógio', r.s === 200 && r.j.idx === 1 && new Date((await linha('TST100')).pergunta_inicio).getTime() === new Date(ini1).getTime());

    console.log('\nPontos caem com o tempo (relógio do servidor)');
    await recuar('TST100', cfg.tempo / 2);
    r = await certa('TST100', 1);
    t('acerto na metade do tempo vale ~pct[1]', r.j.acertou && r.j.pontos <= valorEm(cfg, n, .5) && r.j.pontos >= valorEm(cfg, n, .5 + 4 / cfg.tempo), `${r.j.pontos} esperado ~${valorEm(cfg, n, .5)}`);
    await prox('TST100');
    await recuar('TST100', cfg.tempo + 1);   // dentro da folga de rede: vale o mínimo
    r = await certa('TST100', 2);
    t('acerto logo após o tempo (folga de rede) vale o mínimo, pct[2]', r.j.acertou && r.j.pontos === valorEm(cfg, n, 1), JSON.stringify(r.j));
    const ptsTotal = r.j.placar;
    if(n > 3){ await prox('TST100'); await recuar('TST100', cfg.tempo + 30); r = await certa('TST100', 3);
      t('resposta muito depois do tempo (cliente adulterado) → tempo esgotado, 0 pontos, fim', r.j.tempoEsgotado === true && r.j.acertou === false && r.j.pontos === 0 && r.j.fim === true && r.j.placar === ptsTotal, JSON.stringify(r.j)); }
    t('partida encerrada: não aceita mais respostas nem perguntas', (await resp('TST100', n > 3 ? 4 : 3, 0)).s === 409 && (await prox('TST100')).s === 409);

    console.log('\nErrar ou deixar o tempo acabar encerra a partida');
    await entrar('TST110', 'Erra'); await iniciar('TST110'); await prox('TST110');
    r = await resp('TST110', 0, (corretas[0] + 1) % 4);
    t('resposta errada → 0 pontos, mostra a certa, fim e total do jogador', r.j.acertou === false && r.j.tempoEsgotado === false && r.j.correta === corretas[0] && r.j.pontos === 0 && r.j.fim === true && r.j.jogador.pontosTotal === 0, JSON.stringify(r.j));
    await entrar('TST111', 'Dorme'); await iniciar('TST111'); await prox('TST111');
    r = await resp('TST111', 0, null);
    t('sem alternativa (tempo esgotado no cliente) → tempoEsgotado e fim', r.j.tempoEsgotado === true && r.j.fim === true && r.j.pontos === 0, JSON.stringify(r.j));
    const l111 = await linha('TST111');
    t('tempo gasto na pergunta perdida = tempo cheio', l111.tempo === cfg.tempo * 1000, String(l111.tempo));

    console.log('\nPartida completa e pontos parciais');
    await entrar('TST120', 'Perfeito'); await iniciar('TST120'); await prox('TST120');
    for(let i = 0; i < n; i++){ if(i) await prox('TST120'); r = await certa('TST120', i); }
    t('acertar tudo → fim na última, ' + n + ' acertos', r.j.fim === true && r.j.acertos === n && r.j.jogador.partidas === 1, JSON.stringify(r.j));
    const l120 = await linha('TST120');
    t('banco: finalizada, total e pontos batem com o placar', l120.finalizada && l120.total === n && l120.p === r.j.placar && l120.acertos === n);
    t('ranking tem os pontos do servidor', (await c.get('/api/ranking?dia=1')).j.jogadores.find(j => j.matricula === 'TST120').pontosTotal === r.j.placar);
    await entrar('TST121', 'Abandona'); await iniciar('TST121'); await prox('TST121');
    const r121 = await certa('TST121', 0);
    t('quem abandona no meio fica com os pontos já ganhos', (await c.get('/api/ranking')).j.jogadores.find(j => j.matricula === 'TST121')?.pontosTotal === r121.j.pontos && r121.j.pontos > 0);

    console.log('\nDesempate no ranking (todos com 100.000 pontos)');
    await sql`DELETE FROM respostas WHERE matricula LIKE 'TST%'`; await sql`DELETE FROM partidas WHERE matricula LIKE 'TST%'`;
    const empatar = async (m, nome, acertos, tempo, atras = 0) => {
      await entrar(m, nome); await iniciar(m);
      await sql`UPDATE partidas SET pontos=100000, acertos=${acertos}, total=5, tempo_ms=${tempo}, finalizada=TRUE, pergunta_inicio=NULL, fim = now() - make_interval(secs => ${atras}::float8) WHERE matricula=${m}`;
    };
    await empatar('TST200', 'Zeca', 2, 30000);         // menos acertos
    await empatar('TST201', 'Bia', 3, 50000);          // mais acertos, mais lento
    await empatar('TST202', 'Caio', 3, 20000, 10);     // mais acertos, mais rápido, terminou antes (vence)
    await empatar('TST203', 'Ana', 3, 20000);          // empate total com Caio, terminou depois
    let rk = (await c.get('/api/ranking')).j.jogadores.filter(j => j.matricula.startsWith('TST')).map(j => j.nome);
    t('ordem: Caio > Ana > Bia > Zeca (acertos, tempo, quem terminou antes)', rk.join() === 'Caio,Ana,Bia,Zeca', rk.join());

    console.log('\nVirada do dia com partida em andamento');
    await sql`DELETE FROM partidas WHERE matricula LIKE 'TST%'`;
    await entrar('TST300', 'Andando'); await entrar('TST301', 'Chegou depois');
    t('TST300 abre o dia 1 antes da virada', (await iniciar('TST300')).s === 200);
    await putCfg(new Date(Date.now() - 20000).toISOString());
    t('depois da virada: abrir o dia 1 é recusado', (await iniciar('TST301', 1)).s === 409);
    t('depois da virada: abrir o dia 2 funciona', (await iniciar('TST301', 2)).s === 200);
    await prox('TST300');   // abre a 1ª pergunta já depois da virada: quem abriu o dia 1 antes continua
    r = await certa('TST300', 0);
    t('quem já estava no dia 1 CONTINUA e responde normalmente (não é bloqueado)', r.s === 200 && r.j.acertou, JSON.stringify(r));
    t('…e recebe a próxima pergunta do dia 1', (await prox('TST300')).j?.idx === 1);
    t('…e os pontos ficam no dia 1', (await c.get('/api/ranking?dia=1')).j.jogadores.some(j => j.matricula === 'TST300' && j.pontosTotal === r.j.pontos));
    await putCfg(new Date(Date.now() - 3600e3).toISOString());
    r = await certa('TST300', 1);
    t('muito depois da virada (passou da tolerância) → 409 "dia encerrado"', r.s === 409 && /encerrado/.test(r.j.erro), JSON.stringify(r));
    t('…mas os pontos já feitos continuam no ranking', (await c.get('/api/ranking?dia=1')).j.jogadores.some(j => j.matricula === 'TST300' && j.pontosTotal > 0));
    await putCfg(null);

    console.log('\nLiberar nova tentativa (admin)');
    t('liberar sem login → 401', (await c.post('/api/admin/liberar', { matricula:'TST300', dia:1 })).s === 401);
    t('liberar com login → 200', (await c.post('/api/admin/liberar', { matricula:'TST300', dia:1 }, A)).s === 200);
    t('liberar de novo (nada a apagar) → 404', (await c.post('/api/admin/liberar', { matricula:'TST300', dia:1 }, A)).s === 404);
    t('pontos do dia liberado saem do total', (await c.post('/api/login', { matricula:'TST300' })).j.jogador.pontosTotal === 0);
    t('pode jogar de novo', (await iniciar('TST300')).s === 200);

    console.log('\nCorridas simultâneas');
    await entrar('TST400', 'Corrida');
    const rs = await Promise.all(Array.from({ length:15 }, () => iniciar('TST400')));
    t('15 inícios simultâneos: só 1 aceito', rs.filter(x => x.s === 200).length === 1 && rs.filter(x => x.s === 409).length === 14, rs.map(x => x.s).join());
    await prox('TST400');
    const rr = await Promise.all(Array.from({ length:10 }, () => certa('TST400', 0)));
    const aceitas = rr.filter(x => x.s === 200);
    t('10 respostas simultâneas à mesma pergunta: só 1 conta', aceitas.length === 1 && rr.filter(x => x.s === 409).length === 9, rr.map(x => x.s).join());
    const l400 = await linha('TST400');
    t('pontos contados uma única vez', l400.p === aceitas[0].j.pontos && l400.acertos === 1 && l400.idx === 1, JSON.stringify(l400));
  } finally {
    if(!nDia2) await sql`DELETE FROM perguntas WHERE dia=2 AND enunciado='TST dia 2'`;
    await sql`DELETE FROM partidas WHERE matricula LIKE 'TST%'`; await sql`DELETE FROM jogadores WHERE matricula LIKE 'TST%'`;
    await sql`UPDATE config SET valor=${cfgAntes} WHERE chave='jogo'`;
    if(estadoAntes) await sql`UPDATE config SET valor=${estadoAntes.valor} WHERE chave='estado'`; else await sql`DELETE FROM config WHERE chave='estado'`;
    proc.kill();
    const [x] = await sql`SELECT (SELECT COUNT(*) FROM jogadores)::int j, (SELECT COUNT(*) FROM partidas)::int p, (SELECT COUNT(*) FROM perguntas)::int q`;
    console.log('\nBanco após limpeza:', JSON.stringify(x), '| config restaurada:', cfgAntes);
  }
  console.log(`\n${ok} passaram, ${ruins.length} falharam`); ruins.forEach(x => console.log(' -', x));
  if(ruins.length) process.exitCode = 1;
})().catch(e => { console.error(e); process.exit(1); });
