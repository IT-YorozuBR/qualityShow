/* Infraestrutura dos testes: sobe um servidor com credenciais de admin SÓ de teste,
   faz backup do banco antes e restaura no fim.
   Usa sempre o banco LOCAL (PGlite em .dados-teste/testes, recriado a cada execução); nunca o de produção. */
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const RAIZ = path.join(__dirname, '..');
try { process.loadEnvFile(path.join(RAIZ, '.env.local')); } catch {}
delete process.env.VERCEL;
process.env.BANCO_LOCAL_DIR = path.join(RAIZ, '.dados-teste', 'testes');
fs.rmSync(process.env.BANCO_LOCAL_DIR, { recursive:true, force:true });
const sql = require('../lib/db');
const { iniciarBanco } = require('../lib/app');

const SENHA_TESTE = crypto.randomBytes(12).toString('hex');   // descartável, vale só para este processo
const SALT = crypto.randomBytes(16);
const ENV_TESTE = {
  ADMIN_USER:'admin',
  ADMIN_HASH:`${SALT.toString('hex')}:${crypto.scryptSync(SENHA_TESTE, SALT, 64).toString('hex')}`,
  ADMIN_SEGREDO:crypto.randomBytes(32).toString('hex')
};

const ARQ_BACKUP = path.join(__dirname, '.backup-banco.json');
const TABELAS = ['perguntas', 'config', 'jogadores', 'partidas', 'respostas', 'relatorios'];

async function fazerBackup(){
  const b = {};
  for(const t of TABELAS) b[t] = await sql.query(`SELECT * FROM ${t}`);
  fs.writeFileSync(ARQ_BACKUP, JSON.stringify(b));
  return b;
}

/* Apaga tudo e reinsere o backup (tabelas pequenas; ids originais preservados) */
async function restaurar(b = JSON.parse(fs.readFileSync(ARQ_BACKUP, 'utf8'))){
  await sql.transaction([
    sql`DELETE FROM respostas`, sql`DELETE FROM relatorios`, sql`DELETE FROM partidas`, sql`DELETE FROM jogadores`, sql`DELETE FROM perguntas`, sql`DELETE FROM config`,
    ...b.config.map(r => sql`INSERT INTO config(chave, valor) VALUES(${r.chave}, ${r.valor})`),
    ...b.perguntas.map(r => sql`INSERT INTO perguntas(id, ordem, enunciado, alts, correta, dia) VALUES(${r.id}, ${r.ordem}, ${r.enunciado}, ${r.alts}, ${r.correta}, ${r.dia})`),
    ...b.jogadores.map(r => sql`INSERT INTO jogadores(matricula, nome, pontos_total, melhor, partidas, criado_em, atualizado_em) VALUES(${r.matricula}, ${r.nome}, ${r.pontos_total}, ${r.melhor}, ${r.partidas}, ${r.criado_em}, ${r.atualizado_em})`),
    ...b.relatorios.map(r => sql`INSERT INTO relatorios(id, criado_em, titulo, dados) VALUES(${r.id}, ${r.criado_em}, ${r.titulo}, ${r.dados})`),
    ...b.respostas.map(r => sql`INSERT INTO respostas(id, matricula, dia, idx, alt, acertou, tempo_ms, pontos, criado_em) VALUES(${r.id}, ${r.matricula}, ${r.dia}, ${r.idx}, ${r.alt}, ${r.acertou}, ${r.tempo_ms}, ${r.pontos}, ${r.criado_em})`),
    ...b.partidas.map(r => sql`INSERT INTO partidas(id, matricula, pontos, acertos, total, criado_em, dia, tempo_ms, finalizada, fim, idx, pergunta_inicio)
      VALUES(${r.id}, ${r.matricula}, ${r.pontos}, ${r.acertos}, ${r.total}, ${r.criado_em}, ${r.dia}, ${r.tempo_ms ?? 0}, ${r.finalizada ?? true}, ${r.fim ?? null}, ${r.idx ?? 0}, ${r.pergunta_inicio ?? null})`)
  ]);
  fs.rmSync(ARQ_BACKUP, { force:true });
}

/* O jogo nasce fechado; os testes o abrem (e podem fechá-lo de novo pela API) */
async function abrirJogo(){
  const v = JSON.stringify({ estado:'aberto', iniciadoEm:new Date().toISOString(), encerradoEm:null });
  await sql`INSERT INTO config(chave, valor) VALUES('estado', ${v}) ON CONFLICT (chave) DO UPDATE SET valor = EXCLUDED.valor`;
}

/* Servidor no MESMO processo dos testes (o PGlite só admite um processo); devolve { kill() } */
async function subirServidor(porta){
  Object.assign(process.env, ENV_TESTE);
  const servidor = require('node:http').createServer(require('../lib/http').atender).listen(porta);
  for(let i = 0; i < 100 && !servidor.listening; i++) await new Promise(r => setTimeout(r, 100));
  if(!servidor.listening) throw new Error('Servidor não subiu.');
  return { kill(){ servidor.closeAllConnections(); servidor.close(); } };
}

function criarCliente(base){
  const chamar = async (metodo, url, corpo, cab = {}) => {
    const t0 = performance.now();
    const r = await fetch(base + url, { method:metodo, headers:{ 'Content-Type':'application/json', ...cab }, body:corpo === undefined ? undefined : JSON.stringify(corpo) });
    const txt = await r.text();
    let json = null; try { json = JSON.parse(txt); } catch {}
    return { status:r.status, json, txt, ms:performance.now() - t0, tipo:r.headers.get('content-type') };
  };
  const bruto = (url, corpo) => fetch(base + url, { method:'POST', headers:{ 'Content-Type':'application/json' }, body:corpo }).then(async r => ({ status:r.status, txt:await r.text() }));
  return { chamar, bruto, get:(u, h) => chamar('GET', u, undefined, h), post:(u, b, h) => chamar('POST', u, b, h), put:(u, b, h) => chamar('PUT', u, b, h) };
}

async function tokenAdmin(c, senha = SENHA_TESTE){
  const r = await c.post('/api/admin/login', { usuario:'admin', senha });
  return r.json && r.json.token ? { Authorization:'Bearer ' + r.json.token } : null;
}

/* Executa `corpo({ c, A, sql })` com backup/restauração garantidos */
async function executar(corpo){
  const porta = 3100 + Math.floor(Math.random() * 800);
  await iniciarBanco();   // cria as tabelas (banco local novo)
  await fazerBackup();
  let proc, codigo = 0;
  const limpar = async () => { try { proc && proc.kill(); } catch {} await restaurar(); };
  process.on('SIGINT', async () => { await limpar(); process.exit(130); });
  try {
    await abrirJogo();
    proc = await subirServidor(porta);
    const c = criarCliente(`http://localhost:${porta}`);
    const A = await tokenAdmin(c);
    await corpo({ c, A, sql, porta });
  } catch(e){ console.error('\nFALHA FATAL:', e); codigo = 1; }
  finally { await limpar(); console.log('\n(banco restaurado ao estado anterior)'); }
  return codigo;
}

module.exports = { abrirJogo, executar, subirServidor, iniciarBanco, sql, tokenAdmin, SENHA_TESTE, ENV_TESTE };
