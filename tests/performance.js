/* Testes de desempenho da API.  Uso: npm run test:perf
   Mede latência (p50/p95/máx), vazão sob concorrência e ranking com muitos jogadores.
   Atenção: faz backup do banco e o restaura no fim — rode num branch de teste do Neon. */
const { executar } = require('./_base');

const pct = (v, p) => v.slice().sort((a, b) => a - b)[Math.min(v.length - 1, Math.floor(v.length * p))];
const linha = (nome, ms) => console.log(`  ${nome.padEnd(34)} p50 ${pct(ms, .5).toFixed(0).padStart(5)} ms   p95 ${pct(ms, .95).toFixed(0).padStart(5)} ms   máx ${Math.max(...ms).toFixed(0).padStart(5)} ms`);
let falhou = false;
const limite = (nome, valor, max) => { const ok = valor <= max; if(!ok) falhou = true; console.log(`  ${ok ? '✓' : '✗'} ${nome}: ${valor.toFixed(0)} ms (limite ${max} ms)`); };

/* Dispara `total` chamadas com no máximo `paralelo` ao mesmo tempo */
async function carga(total, paralelo, fn){
  const ms = []; let erros = 0, i = 0; const t0 = performance.now();
  await Promise.all(Array.from({ length:paralelo }, async () => {
    while(i < total){ const k = i++; const r = await fn(k); ms.push(r.ms); if(r.status >= 400) erros++; }
  }));
  return { ms, erros, seg:(performance.now() - t0) / 1000 };
}

executar(async ({ c, A, sql }) => {
  const mat = i => 'PERF' + String(i).padStart(4, '0');
  const corretas = (await sql`SELECT correta FROM perguntas WHERE dia=1 ORDER BY ordem`).map(r => r.correta);
  const jogar = async i => {          // uma partida completa conduzida pelo servidor: iniciar + (proxima + responder) por pergunta
    const a = await c.post('/api/partida/iniciar', { matricula:mat(i), dia:1 });
    if(a.status >= 400) return a;
    let ms = a.ms, ult = a;
    for(let k = 0; k < a.json.total; k++){
      if(k){ const p = await c.post('/api/partida/proxima', { matricula:mat(i), dia:1 }); ms += p.ms; if(p.status >= 400) return { ...p, ms }; }
      ult = await c.post('/api/partida/responder', { matricula:mat(i), dia:1, idx:k, alt:corretas[k] });
      ms += ult.ms; if(ult.status >= 400 || ult.json.fim) break;
    }
    return { ...ult, ms };
  };

  console.log('\nLatência sequencial (30 chamadas cada; inclui ida e volta ao Neon)');
  await c.get('/api/estado');   // aquece: cria/verifica tabelas
  await carga(330, 20, i => c.post('/api/login', { matricula:mat(i), nome:'Jogador ' + i }));   // 330 jogadores
  const seq = async (nome, fn, n = 30) => { const ms = []; for(let i = 0; i < n; i++) ms.push((await fn(i)).ms); linha(nome, ms); return ms; };
  const e = await seq('GET  /api/estado', () => c.get('/api/estado'));
  await seq('POST /api/login (existente)', () => c.post('/api/login', { matricula:mat(0), nome:'x' }));
  const part = await seq('partida completa (~9 chamadas)', i => jogar(300 + i));
  const rk0 = await seq('GET  /api/ranking (30 jogadores)', () => c.get('/api/ranking'));
  await seq('GET  /index.html (estático)', () => c.get('/index.html'));
  limite('estado p95', pct(e, .95), 800);
  limite('ranking p95', pct(rk0, .95), 800);
  limite('partida completa p95', pct(part, .95), 5000);

  console.log('\nPartidas em massa: 300 jogadores jogando (20 em paralelo)');
  const massa = await carga(300, 20, jogar);
  console.log(`  ${massa.ms.length} partidas completas em ${massa.seg.toFixed(1)} s (${(massa.ms.length / massa.seg).toFixed(1)}/s), erros ${massa.erros}`);
  if(massa.erros) falhou = true;
  limite('partida completa sob carga p95', pct(massa.ms, .95), 12000);

  console.log('\nRanking com 330 jogadores com partida');
  const rk = await seq('GET /api/ranking (geral)', () => c.get('/api/ranking'));
  await seq('GET /api/ranking?dia=1', () => c.get('/api/ranking?dia=1'));
  limite('ranking grande p95', pct(rk, .95), 1500);
  console.log(`  tamanho da resposta do ranking: ${((await c.get('/api/ranking')).txt.length / 1024).toFixed(1)} KB`);

  console.log('\nCarga simultânea (simulando a sala toda abrindo e jogando junta)');
  for(const [rot, total, par, fn] of [
    ['GET  /api/estado', 200, 50, () => c.get('/api/estado')],
    ['GET  /api/ranking', 100, 30, () => c.get('/api/ranking')],
    ['POST /api/login', 200, 40, k => c.post('/api/login', { matricula:mat(k % 330), nome:'x' })]
  ]){
    const r = await carga(total, par, fn);
    console.log(`  ${rot.padEnd(20)} ${total} chamadas, ${par} em paralelo: ${(total / r.seg).toFixed(0)} req/s, p95 ${pct(r.ms, .95).toFixed(0)} ms, erros ${r.erros}`);
    if(r.erros) falhou = true;
  }

  console.log('\nLimite de 1 partida por dia sob concorrência');
  const rs = await Promise.all(Array.from({ length:30 }, () => c.post('/api/partida/iniciar', { matricula:mat(329), dia:1 })));
  const aceitos = rs.filter(r => r.status === 200).length;
  console.log(`  ${aceitos <= 1 ? '✓' : '✗'} 30 inícios simultâneos da mesma matrícula: ${aceitos} aceito(s) (esperado: 0 ou 1)`);
  if(aceitos > 1) falhou = true;

  console.log('\nIntegridade após a carga');
  const [{ somaPart }] = await sql`SELECT COALESCE(SUM(pontos),0)::bigint AS "somaPart" FROM partidas`;
  const somaRank = (await c.get('/api/ranking')).json.jogadores.reduce((s, j) => s + j.pontosTotal, 0);
  const ok = Number(somaPart) === somaRank;
  if(!ok) falhou = true;
  console.log(`  ${ok ? '✓' : '✗'} soma das partidas (${somaPart}) = soma do ranking (${somaRank})`);
  const [{ dup }] = await sql`SELECT COUNT(*)::int AS dup FROM (SELECT 1 FROM partidas GROUP BY matricula, dia HAVING COUNT(*) > 1) x`;
  console.log(`  ${dup === 0 ? '✓' : '✗'} nenhuma matrícula com 2 partidas no mesmo dia`);
  if(dup) falhou = true;

  console.log(falhou ? '\nDESEMPENHO: houve falhas' : '\nDESEMPENHO: OK');
  if(falhou) process.exitCode = 1;
}).then(c => { if(c) process.exitCode = c; });
