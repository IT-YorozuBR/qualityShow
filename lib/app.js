/* ==========================================================
   RUMO AO MILHÃO — API + banco (Neon Postgres)
   Usado pelo servidor local (server.js) e pela função da Vercel (api/[...rota].js).
   Requer a variável de ambiente DATABASE_URL.
   ========================================================== */
const crypto = require('node:crypto');
const { neon } = require('@neondatabase/serverless');

const sql = neon(process.env.DATABASE_URL);

/* ---------- Banco ---------- */
const PERGUNTAS_PADRAO = [
  { enunciado:'Qual é o maior planeta do Sistema Solar?', alts:['Saturno','Júpiter','Netuno','Terra'], correta:1 },
  { enunciado:'Quem pintou o quadro "Mona Lisa"?', alts:['Michelangelo','Rafael','Leonardo da Vinci','Botticelli'], correta:2 },
  { enunciado:'Qual é a capital da Austrália?', alts:['Sydney','Melbourne','Perth','Canberra'], correta:3 },
  { enunciado:'Quantos jogadores de cada time ficam em campo numa partida de futebol?', alts:['11','10','12','9'], correta:0 },
  { enunciado:'Qual elemento químico tem o símbolo "O"?', alts:['Ouro','Osmio','Oxigênio','Ozônio'], correta:2 }
];
const CONFIG_PADRAO = { total:1000000, tempo:90, pct:[100,60,30], virada:null };

/* Cria as tabelas e popula os dados padrão (uma vez por instância) */
let pronto = null;
function iniciarBanco(){
  if(!pronto) pronto = (async () => {
    await sql.transaction([
      sql`CREATE TABLE IF NOT EXISTS perguntas(
        id        SERIAL PRIMARY KEY,
        ordem     INTEGER NOT NULL,
        enunciado TEXT    NOT NULL,
        alts      TEXT    NOT NULL,
        correta   INTEGER NOT NULL
      )`,
      sql`CREATE TABLE IF NOT EXISTS config(
        chave TEXT PRIMARY KEY,
        valor TEXT NOT NULL
      )`,
      sql`CREATE TABLE IF NOT EXISTS jogadores(
        matricula     TEXT PRIMARY KEY,
        nome          TEXT   NOT NULL,
        pontos_total  BIGINT NOT NULL DEFAULT 0,
        melhor        BIGINT NOT NULL DEFAULT 0,
        partidas      INTEGER NOT NULL DEFAULT 0,
        criado_em     TIMESTAMPTZ NOT NULL DEFAULT now(),
        atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now()
      )`,
      sql`CREATE TABLE IF NOT EXISTS partidas(
        id        SERIAL PRIMARY KEY,
        matricula TEXT    NOT NULL REFERENCES jogadores(matricula),
        pontos    BIGINT  NOT NULL,
        acertos   INTEGER NOT NULL,
        total     INTEGER NOT NULL,
        criado_em TIMESTAMPTZ NOT NULL DEFAULT now()
      )`,
      // dia 1 ou 2: as perguntas e as partidas pertencem a um dia
      sql`ALTER TABLE perguntas ADD COLUMN IF NOT EXISTS dia INTEGER NOT NULL DEFAULT 1`,
      sql`ALTER TABLE partidas  ADD COLUMN IF NOT EXISTS dia INTEGER NOT NULL DEFAULT 1`,
      // uma partida por matrícula por dia; tempo e fim servem de desempate
      sql`ALTER TABLE partidas  ADD COLUMN IF NOT EXISTS tempo_ms BIGINT NOT NULL DEFAULT 0`,
      sql`ALTER TABLE partidas  ADD COLUMN IF NOT EXISTS finalizada BOOLEAN NOT NULL DEFAULT TRUE`,
      sql`ALTER TABLE partidas  ADD COLUMN IF NOT EXISTS fim TIMESTAMPTZ`,
      sql`CREATE UNIQUE INDEX IF NOT EXISTS partidas_matricula_dia ON partidas(matricula, dia)`
    ]);
    const [{ n }] = await sql`SELECT COUNT(*)::int AS n FROM perguntas`;
    if(n === 0) await gravarPerguntas(PERGUNTAS_PADRAO);
    await sql`INSERT INTO config(chave, valor) VALUES('jogo', ${JSON.stringify(CONFIG_PADRAO)}) ON CONFLICT(chave) DO NOTHING`;
  })().catch(e => { pronto = null; throw e; });
  return pronto;
}

/* Substitui as perguntas de um dia, sem mexer no outro */
function gravarPerguntas(lista, dia = 1){
  return sql.transaction([
    sql`DELETE FROM perguntas WHERE dia = ${dia}`,
    ...lista.map((p, i) => sql`INSERT INTO perguntas(ordem, enunciado, alts, correta, dia) VALUES(${i}, ${p.enunciado}, ${JSON.stringify(p.alts)}, ${p.correta}, ${dia})`)
  ]);
}

const lerPerguntas = async dia =>
  (await sql`SELECT enunciado, alts, correta FROM perguntas WHERE dia = ${dia} ORDER BY ordem`)
    .map(p => ({ enunciado:p.enunciado, alts:JSON.parse(p.alts), correta:p.correta }));

/* ---------- Virada do dia ----------
   config.virada é o instante (ISO) em que passa a valer o dia 2. Antes dele vale o dia 1. */
async function lerConfig(){
  const [c] = await sql`SELECT valor FROM config WHERE chave = 'jogo'`;
  return { ...CONFIG_PADRAO, ...JSON.parse(c.valor) };
}
const diaAtual = cfg => cfg.virada && Date.now() >= Date.parse(cfg.virada) ? 2 : 1;

/* ---------- Validação ---------- */
class ErroHttp extends Error { constructor(status, msg){ super(msg); this.status = status; } }

const texto = (v, max) => typeof v === 'string' && v.trim().length > 0 && v.trim().length <= max;
const inteiro = (v, min, max) => Number.isInteger(v) && v >= min && v <= max;

function validarPerguntas(lista){
  if(!Array.isArray(lista) || lista.length > 200) throw new ErroHttp(400, 'Lista de perguntas inválida.');
  return lista.map(p => {
    const ok = p && texto(p.enunciado, 300) && Array.isArray(p.alts) && p.alts.length === 4
      && p.alts.every(a => texto(a, 120)) && inteiro(p.correta, 0, 3);
    if(!ok) throw new ErroHttp(400, 'Pergunta inválida.');
    return { enunciado:p.enunciado.trim(), alts:p.alts.map(a => a.trim()), correta:p.correta };
  });
}

function validarConfig(c){
  const ok = c && typeof c.total === 'number' && c.total > 0 && c.total <= 1e12
    && typeof c.tempo === 'number' && c.tempo >= 3 && c.tempo <= 600
    && Array.isArray(c.pct) && c.pct.length === 3 && c.pct.every(v => typeof v === 'number' && v >= 0 && v <= 100);
  if(!ok) throw new ErroHttp(400, 'Configuração inválida.');
  const virada = c.virada ?? null;
  if(virada !== null && (typeof virada !== 'string' || isNaN(Date.parse(virada)))) throw new ErroHttp(400, 'Data da virada inválida.');
  return { total:c.total, tempo:c.tempo, pct:c.pct, virada:virada && new Date(virada).toISOString() };
}

/* Matrícula: só letras/números/-._ , normalizada em maiúsculas */
function normalizarMatricula(v){
  const m = typeof v === 'string' ? v.trim().toUpperCase() : '';
  if(!/^[A-Z0-9._-]{1,20}$/.test(m)) throw new ErroHttp(400, 'Matrícula inválida. Use de 1 a 20 letras ou números.');
  return m;
}

/* BIGINT volta como texto do driver */
const jogadorJson = j => ({ matricula:j.matricula, nome:j.nome, pontosTotal:Number(j.pontos_total), melhor:Number(j.melhor), partidas:j.partidas });

/* Totais calculados direto das partidas (fonte única) */
const buscarJogador = async matricula => (await sql`
  SELECT j.matricula, j.nome, COALESCE(SUM(p.pontos), 0) AS pontos_total, COALESCE(MAX(p.pontos), 0) AS melhor, COUNT(p.id)::int AS partidas
  FROM jogadores j LEFT JOIN partidas p ON p.matricula = j.matricula
  WHERE j.matricula = ${matricula}
  GROUP BY j.matricula, j.nome`)[0];

const jaJogou = async (matricula, dia) => (await sql`SELECT 1 FROM partidas WHERE matricula = ${matricula} AND dia = ${dia}`).length > 0;

/* ---------- Autenticação do admin ----------
   ADMIN_USER, ADMIN_HASH (salt:scrypt em hex) e ADMIN_SEGREDO vêm das variáveis de ambiente.
   O login devolve um token assinado (HMAC) que vale 12h e vai no cabeçalho Authorization. */
const TOKEN_MS = 12 * 3600 * 1000;
const iguais = (a, b) => a.length === b.length && crypto.timingSafeEqual(a, b);

function senhaConfere(usuario, senha){
  const [salt, hash] = (process.env.ADMIN_HASH || '').split(':');
  if(!salt || !hash || !process.env.ADMIN_USER) return false;
  const calc = crypto.scryptSync(String(senha).normalize('NFC'), Buffer.from(salt, 'hex'), 64);
  const userOk = iguais(Buffer.from(String(usuario)), Buffer.from(process.env.ADMIN_USER));
  return iguais(calc, Buffer.from(hash, 'hex')) && userOk;
}

const assinar = dados => crypto.createHmac('sha256', process.env.ADMIN_SEGREDO || '').update(dados).digest('base64url');

function criarToken(){
  const dados = Buffer.from(JSON.stringify({ exp:Date.now() + TOKEN_MS })).toString('base64url');
  return `${dados}.${assinar(dados)}`;
}

function exigirAdmin(req){
  const [dados, ass] = (req.headers.authorization || '').replace(/^Bearer /, '').split('.');
  let ok = false;
  if(dados && ass && process.env.ADMIN_SEGREDO && iguais(Buffer.from(assinar(dados)), Buffer.from(ass))){
    try { ok = JSON.parse(Buffer.from(dados, 'base64url').toString()).exp > Date.now(); } catch {}
  }
  if(!ok) throw new ErroHttp(401, 'Sessão de administrador inválida. Entre novamente.');
}

/* ---------- Rotas da API ---------- */
const rotas = {
  /* Jogo: só as perguntas do dia em vigor (as do outro dia não saem do servidor) */
  'GET /api/estado': async () => {
    const config = await lerConfig();
    const dia = diaAtual(config);
    return { dia, perguntas:await lerPerguntas(dia), config };
  },

  /* Admin: perguntas dos dois dias + configuração */
  'GET /api/admin/perguntas': async (body, req) => {
    exigirAdmin(req);
    const config = await lerConfig();
    return { dia:diaAtual(config), perguntas:{ 1:await lerPerguntas(1), 2:await lerPerguntas(2) }, config };
  },

  'POST /api/admin/login': async body => {
    if(!senhaConfere(body.usuario ?? '', body.senha ?? '')){
      await new Promise(r => setTimeout(r, 800));   // desacelera tentativas em sequência
      throw new ErroHttp(401, 'Usuário ou senha incorretos.');
    }
    return { token:criarToken() };
  },

  'GET /api/admin/sessao': async (body, req) => { exigirAdmin(req); return { ok:true }; },

  'PUT /api/perguntas': async (body, req) => {
    exigirAdmin(req);
    if(body.dia !== 1 && body.dia !== 2) throw new ErroHttp(400, 'Dia inválido.');
    await gravarPerguntas(validarPerguntas(body.perguntas), body.dia);
    return { ok:true };
  },

  'PUT /api/config': async (body, req) => {
    exigirAdmin(req);
    await sql`INSERT INTO config(chave, valor) VALUES('jogo', ${JSON.stringify(validarConfig(body.config))})
              ON CONFLICT(chave) DO UPDATE SET valor = excluded.valor`;
    return { ok:true };
  },

  /* Entrada com matrícula: cria o cadastro na primeira vez, reaproveita nas seguintes */
  'POST /api/login': async body => {
    const matricula = normalizarMatricula(body.matricula);
    let j = await buscarJogador(matricula);
    let novo = false;
    if(!j){
      if(typeof body.nome !== 'string' || !body.nome.trim()) throw new ErroHttp(404, 'Matrícula não cadastrada. Informe seu nome para se cadastrar.');
      if(!texto(body.nome, 24)) throw new ErroHttp(400, 'Nome inválido (até 24 caracteres).');
      await sql`INSERT INTO jogadores(matricula, nome) VALUES(${matricula}, ${body.nome.trim()}) ON CONFLICT DO NOTHING`;
      j = await buscarJogador(matricula);
      novo = true;
    }
    const dia = diaAtual(await lerConfig());
    return { novo, dia, jogou:await jaJogou(matricula, dia), jogador:jogadorJson(j) };
  },

  /* Início de partida: reserva a vaga do dia (1 por matrícula). Recarregar a página não dá nova chance. */
  'POST /api/partida/iniciar': async body => {
    const matricula = normalizarMatricula(body.matricula);
    if(!await buscarJogador(matricula)) throw new ErroHttp(404, 'Matrícula não cadastrada.');
    const dia = diaAtual(await lerConfig());
    if(body.dia !== dia) throw new ErroHttp(409, 'O dia do jogo mudou. Volte ao início e entre de novo.');
    const r = await sql`INSERT INTO partidas(matricula, pontos, acertos, total, dia, finalizada)
                        VALUES(${matricula}, 0, 0, 0, ${dia}, FALSE)
                        ON CONFLICT (matricula, dia) DO NOTHING RETURNING id`;
    if(!r.length) throw new ErroHttp(409, `Você já jogou o Dia ${dia}. Cada matrícula joga uma vez por dia.`);
    return { ok:true, dia };
  },

  /* Fim de partida: grava pontos, acertos e tempo na partida iniciada */
  'POST /api/partida': async body => {
    const cfg = await lerConfig();
    const atual = diaAtual(cfg);
    if(body.dia !== 1 && body.dia !== 2) throw new ErroHttp(400, 'Dia inválido.');
    const matricula = normalizarMatricula(body.matricula);
    if(!await buscarJogador(matricula)) throw new ErroHttp(404, 'Matrícula não cadastrada.');
    const tempoMs = body.tempoMs ?? 0;
    if(!inteiro(body.pontos, 0, cfg.total + 1000) || !inteiro(body.acertos, 0, 1000) || !inteiro(body.total, 0, 1000)
       || body.acertos > body.total || !inteiro(tempoMs, 0, 86400000))
      throw new ErroHttp(400, 'Dados da partida inválidos.');
    /* Partida do dia 1 iniciada antes da virada pode terminar: vale por até (perguntas × tempo + 1 min) depois dela */
    if(body.dia !== atual){
      const n1 = (await lerPerguntas(1)).length;
      const limite = Date.parse(cfg.virada) + n1 * cfg.tempo * 1000 + 60000;
      if(!(body.dia < atual && Date.now() <= limite)) throw new ErroHttp(409, 'Este dia já foi encerrado. Sua pontuação não foi registrada.');
    }
    /* o tempo informado não pode passar do que o servidor viu desde o início da partida */
    const r = await sql`UPDATE partidas
      SET pontos = ${body.pontos}, acertos = ${body.acertos}, total = ${body.total},
          tempo_ms = LEAST(${tempoMs}::bigint, (EXTRACT(EPOCH FROM (now() - criado_em)) * 1000)::bigint + 2000),
          finalizada = TRUE, fim = now()
      WHERE matricula = ${matricula} AND dia = ${body.dia} AND finalizada = FALSE
      RETURNING id`;
    if(!r.length) throw new ErroHttp(409, 'Partida não iniciada ou já registrada.');
    return { jogador:jogadorJson(await buscarJogador(matricula)) };
  },

  /* Admin: libera nova tentativa (ex.: queda de energia/internet durante a partida) */
  'POST /api/admin/liberar': async (body, req) => {
    exigirAdmin(req);
    const matricula = normalizarMatricula(body.matricula);
    if(body.dia !== 1 && body.dia !== 2) throw new ErroHttp(400, 'Dia inválido.');
    const r = await sql`DELETE FROM partidas WHERE matricula = ${matricula} AND dia = ${body.dia} RETURNING id`;
    if(!r.length) throw new ErroHttp(404, 'Essa matrícula não tem partida registrada nesse dia.');
    return { ok:true };
  },

  /* ?dia=1, ?dia=2 ou sem parâmetro (geral, soma dos dois dias).
     Desempate: mais acertos, menor tempo total, quem terminou primeiro, nome. */
  'GET /api/ranking': async (body, req) => {
    const d = new URL(req.url, 'http://localhost').searchParams.get('dia');
    const dia = d === '1' ? 1 : d === '2' ? 2 : null;
    const linhas = await sql`
      SELECT j.matricula, j.nome, SUM(p.pontos) AS pontos_total, MAX(p.pontos) AS melhor, COUNT(p.id)::int AS partidas
      FROM jogadores j JOIN partidas p ON p.matricula = j.matricula
      WHERE ${dia}::int IS NULL OR p.dia = ${dia}::int
      GROUP BY j.matricula, j.nome
      ORDER BY SUM(p.pontos) DESC, SUM(p.acertos) DESC, SUM(p.tempo_ms) ASC, MAX(p.fim) ASC NULLS LAST, j.nome`;
    return { jogadores:linhas.map(jogadorJson) };
  }
};

/* ---------- HTTP ---------- */
function lerCorpo(req){
  return new Promise((resolve, reject) => {
    let dados = '';
    req.on('data', c => {
      dados += c;
      if(dados.length > 1e6){ reject(new ErroHttp(413, 'Corpo grande demais.')); req.destroy(); }
    });
    req.on('end', () => {
      if(!dados) return resolve({});
      try { resolve(JSON.parse(dados)); } catch { reject(new ErroHttp(400, 'JSON inválido.')); }
    });
    req.on('error', reject);
  });
}

function responder(res, status, corpo, tipo = 'application/json; charset=utf-8'){
  res.writeHead(status, { 'Content-Type':tipo, 'Cache-Control':'no-store' });
  res.end(typeof corpo === 'string' ? corpo : JSON.stringify(corpo));
}

/* Atende uma requisição /api/*; devolve false se a rota não existe */
async function tratarApi(req, res){
  const { pathname } = new URL(req.url, 'http://localhost');
  const rota = rotas[`${req.method} ${pathname}`];
  if(!rota) return false;
  try {
    await iniciarBanco();
    const body = req.method === 'GET' ? {} : await lerCorpo(req);
    responder(res, 200, await rota(body, req));
  } catch(e){
    if(!(e instanceof ErroHttp)) console.error(e);
    responder(res, e.status || 500, { erro: e instanceof ErroHttp ? e.message : 'Erro interno.' });
  }
  return true;
}

module.exports = { tratarApi, responder };
