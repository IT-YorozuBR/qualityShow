/* Regras do jogo: limite de 1 partida por dia, desempate e virada do dia.
   Usa só dados TST* e restaura a config ao fim (não apaga as outras tabelas).  Uso: npm run test:regras */
const path = require('node:path');
const R = path.join(__dirname, '..') + path.sep;
const { spawn } = require('node:child_process');
const { ENV_TESTE, tokenAdmin, sql } = require('./_base.js');
let ok = 0, ruins = [];
const t = (n, c, x = '') => { c ? ok++ : ruins.push(n + ' ' + x); console.log(c ? '  ✓' : '  ✗', n, c ? '' : x); };
(async () => {
  const porta = 3900 + Math.floor(Math.random() * 90), B = `http://localhost:${porta}`;
  const proc = spawn(process.execPath, ['server.js'], { cwd:R, env:{ ...process.env, ...ENV_TESTE, PORT:String(porta) }, stdio:'ignore' });
  await new Promise(r => setTimeout(r, 2500));
  const call = async (m, u, b, h = {}) => { const r = await fetch(B + u, { method:m, headers:{ 'Content-Type':'application/json', ...h }, body:b && JSON.stringify(b) }); return { s:r.status, j:await r.json().catch(() => null) }; };
  const cfgAntes = (await sql`SELECT valor FROM config WHERE chave='jogo'`)[0].valor;
  const c = { get:(u, h) => call('GET', u, undefined, h), post:(u, b, h) => call('POST', u, b, h) };
  const A = await tokenAdmin({ post:async (u, b) => { const r = await call('POST', u, b); return { json:r.j }; } });
  const putCfg = v => fetch(B + '/api/config', { method:'PUT', headers:{ 'Content-Type':'application/json', ...A }, body:JSON.stringify({ config:{ ...JSON.parse(cfgAntes), virada:v } }) });
  const jogar = async (m, nome, p = {}) => {
    await c.post('/api/login', { matricula:m, nome });
    const i = await c.post('/api/partida/iniciar', { matricula:m, dia:1 });
    if(i.s !== 200) return i;
    const f = await c.post('/api/partida', { matricula:m, dia:1, pontos:p.pontos ?? 100000, acertos:p.acertos ?? 2, total:5, tempoMs:1 });
    // fixa tempo e hora de término para o desempate ser determinístico (o servidor limita o tempo ao que ele viu)
    await sql`UPDATE partidas SET tempo_ms=${p.tempo ?? 30000}, fim = now() - (${p.atras ?? 0} || ' seconds')::interval WHERE matricula=${m}`;
    return f;
  };
  try {
    await putCfg(null);
    console.log('Limite de 1 partida por dia');
    let r = await c.post('/api/login', { matricula:'TST100', nome:'Um' });
    t('login: dia 1, ainda não jogou', r.j.dia === 1 && r.j.jogou === false);
    t('iniciar → 200', (await c.post('/api/partida/iniciar', { matricula:'TST100', dia:1 })).s === 200);
    r = await c.post('/api/partida/iniciar', { matricula:'TST100', dia:1 });
    t('iniciar de novo (recarregar a página) → 409', r.s === 409 && /já jogou/.test(r.j.erro), JSON.stringify(r));
    t('login agora mostra jogou=true', (await c.post('/api/login', { matricula:'TST100' })).j.jogou === true);
    t('iniciar dia errado → 409', (await c.post('/api/partida/iniciar', { matricula:'TST100', dia:2 })).s === 409);
    t('iniciar matrícula inexistente → 404', (await c.post('/api/partida/iniciar', { matricula:'TSTNADA', dia:1 })).s === 404);
    t('finalizar com pontos acima do total do jogo → 400', (await c.post('/api/partida', { matricula:'TST100', dia:1, pontos:5e6, acertos:1, total:5 })).s === 400);
    t('finalizar com acertos > total → 400', (await c.post('/api/partida', { matricula:'TST100', dia:1, pontos:1, acertos:9, total:5 })).s === 400);
    r = await c.post('/api/partida', { matricula:'TST100', dia:1, pontos:123456, acertos:2, total:5, tempoMs:80000000 });
    t('finalizar a partida iniciada → 200 e total certo', r.s === 200 && r.j.jogador.pontosTotal === 123456, JSON.stringify(r));
    const [lin] = await sql`SELECT tempo_ms::int t FROM partidas WHERE matricula='TST100'`;
    t('tempo informado é limitado ao que o servidor viu (' + lin.t + ' ms)', lin.t < 10000);
    t('finalizar duas vezes → 409 (não soma de novo)', (await c.post('/api/partida', { matricula:'TST100', dia:1, pontos:1, acertos:1, total:5 })).s === 409);
    await c.post('/api/login', { matricula:'TST101', nome:'Dois' });
    t('finalizar sem ter iniciado → 409', (await c.post('/api/partida', { matricula:'TST101', dia:1, pontos:1000, acertos:1, total:5 })).s === 409);

    console.log('\nDesempate no ranking (todos com 100.000 pontos)');
    await sql`DELETE FROM partidas WHERE matricula LIKE 'TST%'`;
    await jogar('TST200', 'Zeca', { acertos:2, tempo:30000 });       // menos acertos
    await jogar('TST201', 'Bia',  { acertos:3, tempo:50000 });       // mais acertos, mais lento
    await jogar('TST202', 'Caio', { acertos:3, tempo:20000, atras:10 });       // mais acertos, mais rápido (vence)
    await jogar('TST203', 'Ana',  { acertos:3, tempo:20000 });       // empate total com Caio, terminou depois
    let rk = (await c.get('/api/ranking')).j.jogadores.filter(j => j.matricula.startsWith('TST')).map(j => j.nome);
    t('ordem: Caio > Ana > Bia > Zeca (acertos, tempo, quem terminou antes)', rk.join() === 'Caio,Ana,Bia,Zeca', rk.join());
    t('tempo sobrepõe nome (Zeca ficou por último mesmo vindo do fim do alfabeto por acertos)', rk[3] === 'Zeca');

    console.log('\nVirada do dia com partida em andamento');
    await sql`DELETE FROM partidas WHERE matricula LIKE 'TST%'`;
    await c.post('/api/login', { matricula:'TST300', nome:'Andando' });
    await c.post('/api/login', { matricula:'TST301', nome:'Chegou depois' });
    t('TST300 abre o dia 1 antes da virada', (await c.post('/api/partida/iniciar', { matricula:'TST300', dia:1 })).s === 200);
    await putCfg(new Date(Date.now() - 20000).toISOString());
    t('depois da virada: abrir o dia 1 é recusado', (await c.post('/api/partida/iniciar', { matricula:'TST301', dia:1 })).s === 409);
    t('depois da virada: abrir o dia 2 funciona', (await c.post('/api/partida/iniciar', { matricula:'TST301', dia:2 })).s === 200);
    r = await c.post('/api/partida', { matricula:'TST300', dia:1, pontos:150000, acertos:3, total:5, tempoMs:40000 });
    t('quem já estava no dia 1 TERMINA normalmente (não é bloqueado)', r.s === 200, JSON.stringify(r));
    t('…e os pontos ficam no dia 1', (await c.get('/api/ranking?dia=1')).j.jogadores.some(j => j.matricula === 'TST300' && j.pontosTotal === 150000));
    await putCfg(null);

    console.log('\nLiberar nova tentativa (admin)');
    t('liberar sem login → 401', (await c.post('/api/admin/liberar', { matricula:'TST300', dia:1 })).s === 401);
    t('liberar com login → 200', (await c.post('/api/admin/liberar', { matricula:'TST300', dia:1 }, A)).s === 200);
    t('liberar de novo (nada a apagar) → 404', (await c.post('/api/admin/liberar', { matricula:'TST300', dia:1 }, A)).s === 404);
    t('pontos do dia liberado saem do total', (await c.post('/api/login', { matricula:'TST300' })).j.jogador.pontosTotal === 0);
    t('pode jogar de novo', (await c.post('/api/partida/iniciar', { matricula:'TST300', dia:1 })).s === 200);

    console.log('\nCorridas simultâneas');
    await c.post('/api/login', { matricula:'TST400', nome:'Corrida' });
    const rs = await Promise.all(Array.from({ length:15 }, () => c.post('/api/partida/iniciar', { matricula:'TST400', dia:1 })));
    t('15 inícios simultâneos: só 1 aceito', rs.filter(x => x.s === 200).length === 1 && rs.filter(x => x.s === 409).length === 14, rs.map(x => x.s).join());
  } finally {
    await sql`DELETE FROM partidas WHERE matricula LIKE 'TST%'`; await sql`DELETE FROM jogadores WHERE matricula LIKE 'TST%'`;
    await sql`UPDATE config SET valor=${cfgAntes} WHERE chave='jogo'`;
    proc.kill();
    const [x] = await sql`SELECT (SELECT COUNT(*) FROM jogadores)::int j, (SELECT COUNT(*) FROM partidas)::int p, (SELECT COUNT(*) FROM perguntas)::int q`;
    console.log('\nBanco após limpeza:', JSON.stringify(x), '| config restaurada:', cfgAntes);
  }
  console.log(`\n${ok} passaram, ${ruins.length} falharam`); ruins.forEach(x => console.log(' -', x));
})().catch(e => { console.error(e); process.exit(1); });
