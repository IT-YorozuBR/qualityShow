/* ==========================================================
   RUMO AO MILHÃO — API + banco (Neon Postgres)
   Usado pelo servidor local (server.js) e pela função da Vercel (api/[...rota].js).
   Requer a variável de ambiente DATABASE_URL.
   ========================================================== */
const crypto = require('node:crypto');
const sql = require('./db');   // Neon só na Vercel; em qualquer outro lugar, PGlite local (ver lib/db.js)

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
      sql`CREATE UNIQUE INDEX IF NOT EXISTS partidas_matricula_dia ON partidas(matricula, dia)`,
      // o servidor conduz a partida: idx = próxima pergunta a responder; pergunta_inicio = quando ela foi entregue (NULL = relógio parado)
      sql`ALTER TABLE partidas  ADD COLUMN IF NOT EXISTS idx INTEGER NOT NULL DEFAULT 0`,
      sql`ALTER TABLE partidas  ADD COLUMN IF NOT EXISTS pergunta_inicio TIMESTAMPTZ`,
      // cada resposta dada (alt NULL = tempo esgotado): alimenta as estatísticas por pergunta do dashboard
      sql`CREATE TABLE IF NOT EXISTS respostas(
        id        SERIAL PRIMARY KEY,
        matricula TEXT    NOT NULL,
        dia       INTEGER NOT NULL,
        idx       INTEGER NOT NULL,
        alt       INTEGER,
        acertou   BOOLEAN NOT NULL,
        tempo_ms  BIGINT  NOT NULL,
        pontos    BIGINT  NOT NULL,
        criado_em TIMESTAMPTZ NOT NULL DEFAULT now()
      )`,
      sql`CREATE INDEX IF NOT EXISTS respostas_dia_idx ON respostas(dia, idx)`,
      // fotografias do resultado, salvas ao encerrar o jogo (dados = JSON)
      sql`CREATE TABLE IF NOT EXISTS relatorios(
        id        SERIAL PRIMARY KEY,
        criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
        titulo    TEXT NOT NULL,
        dados     TEXT NOT NULL
      )`
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

/* ---------- Estado do jogo (aberto / fechado) ----------
   'aguardando' = ainda não foi iniciado (padrão); 'aberto' = rolando; 'encerrado' = o admin encerrou.
   Fora do estado 'aberto' ninguém entra nem joga: a tela mostra a fábrica fechada. */
const ESTADO_PADRAO = { estado:'aguardando', iniciadoEm:null, encerradoEm:null };
async function lerEstadoJogo(){
  const [c] = await sql`SELECT valor FROM config WHERE chave = 'estado'`;
  return { ...ESTADO_PADRAO, ...(c ? JSON.parse(c.valor) : {}) };
}
const gravarEstadoJogo = e => sql`INSERT INTO config(chave, valor) VALUES('estado', ${JSON.stringify(e)})
                                  ON CONFLICT(chave) DO UPDATE SET valor = excluded.valor`;
function exigirAberto(e){
  if(e.estado !== 'aberto')
    throw new ErroHttp(423, e.estado === 'encerrado' ? 'O jogo foi encerrado.' : 'O jogo ainda não começou.', { codigo:'FECHADO', estado:e.estado });
}

/* ---------- Pontuação ----------
   Os pontos descem de forma contínua com o tempo: pct[0] no início, pct[1] na metade e pct[2] no fim
   (frac = fração do tempo gasto). Mesma fórmula de valorEm() em public/common.js, que só a mostra na tela. */
function valorEm(cfg, nPerguntas, frac){
  const f = Math.max(0, Math.min(1, frac)), [a, b, c] = cfg.pct;
  const pct = f <= .5 ? a + (b - a) * (f / .5) : b + (c - b) * ((f - .5) / .5);
  return Math.round(cfg.total / nPerguntas * pct / 100);
}

/* Folga para a viagem da resposta pela rede além do tempo da pergunta */
const FOLGA_MS = 3000;
/* Quem abriu o Dia 1 antes da virada pode terminar: vale por até (perguntas × tempo + esta margem) depois dela */
const MARGEM_VIRADA_MS = 120000;

/* A pergunta sai do servidor sem a resposta certa */
const perguntaPublica = p => ({ enunciado:p.enunciado, alts:p.alts });

/* ---------- Validação ---------- */
class ErroHttp extends Error { constructor(status, msg, extra = {}){ super(msg); this.status = status; this.extra = extra; } }

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

/* Partida em andamento de uma matrícula num dia, com o tempo da pergunta atual medido pelo relógio do banco */
const lerPartida = async (matricula, dia) => (await sql`
  SELECT idx, total, finalizada, pergunta_inicio IS NOT NULL AS servida,
         EXTRACT(EPOCH FROM (now() - pergunta_inicio)) * 1000 AS dec_ms
  FROM partidas WHERE matricula = ${matricula} AND dia = ${dia}`)[0];

/* Valida a requisição de uma partida já aberta e junta o que as rotas precisam */
async function partidaEmAndamento(body){
  const matricula = normalizarMatricula(body.matricula);
  if(body.dia !== 1 && body.dia !== 2) throw new ErroHttp(400, 'Dia inválido.');
  const [cfg, p, perguntas, jogo] = await Promise.all([lerConfig(), lerPartida(matricula, body.dia), lerPerguntas(body.dia), lerEstadoJogo()]);
  exigirAberto(jogo);   // encerrado pelo admin: ninguém responde nem pede pergunta
  /* Depois da virada, só o Dia 1 em andamento continua, e por tempo limitado */
  if(body.dia < diaAtual(cfg) && Date.now() > Date.parse(cfg.virada) + perguntas.length * cfg.tempo * 1000 + MARGEM_VIRADA_MS)
    throw new ErroHttp(409, 'Este dia já foi encerrado.');
  if(!p) throw new ErroHttp(409, 'Partida não iniciada.');
  if(p.finalizada) throw new ErroHttp(409, 'Partida já encerrada.');
  return { matricula, dia:body.dia, cfg, p, perguntas };
}

/* ---------- Relatório (dashboard do admin) ----------
   Fotografia do jogo: ranking, resumo e estatísticas por pergunta, geral e por dia.
   Salva na tabela relatorios ao encerrar; também pode ser calculada ao vivo. */
async function montarRelatorio(){
  const [config, jogo] = await Promise.all([lerConfig(), lerEstadoJogo()]);
  const escopos = [['geral', null], ['1', 1], ['2', 2]];
  const ranking = {}, resumo = {}, perguntas = {};

  for(const [nome, dia] of escopos){
    const linhas = await sql`
      SELECT j.matricula, j.nome, SUM(p.pontos) AS pontos, SUM(p.acertos)::int AS acertos, COUNT(p.id)::int AS partidas, SUM(p.tempo_ms) AS tempo_ms
      FROM jogadores j JOIN partidas p ON p.matricula = j.matricula
      WHERE ${dia}::int IS NULL OR p.dia = ${dia}::int
      GROUP BY j.matricula, j.nome
      ORDER BY SUM(p.pontos) DESC, SUM(p.acertos) DESC, SUM(p.tempo_ms) ASC, MAX(p.fim) ASC NULLS LAST, j.nome`;
    ranking[nome] = linhas.map(l => ({ matricula:l.matricula, nome:l.nome, pontos:Number(l.pontos), acertos:l.acertos, partidas:l.partidas, tempoMs:Number(l.tempo_ms) }));

    const [p] = await sql`
      SELECT COUNT(DISTINCT matricula)::int AS jogadores, COUNT(*)::int AS partidas, COUNT(*) FILTER (WHERE finalizada)::int AS finalizadas,
             COALESCE(AVG(pontos), 0) AS media_pontos, COALESCE(MAX(pontos), 0) AS melhor_pontos
      FROM partidas WHERE ${dia}::int IS NULL OR dia = ${dia}::int`;
    const [r] = await sql`
      SELECT COUNT(*)::int AS respostas, COUNT(*) FILTER (WHERE acertou)::int AS acertos, COUNT(*) FILTER (WHERE alt IS NULL)::int AS sem_resposta,
             COALESCE(AVG(tempo_ms), 0) AS tempo_medio
      FROM respostas WHERE ${dia}::int IS NULL OR dia = ${dia}::int`;
    resumo[nome] = {
      jogadores:p.jogadores, partidas:p.partidas, finalizadas:p.finalizadas,
      mediaPontos:Math.round(Number(p.media_pontos)), melhorPontos:Number(p.melhor_pontos),
      respostas:r.respostas, acertos:r.acertos, semResposta:r.sem_resposta,
      taxaAcerto:r.respostas ? r.acertos / r.respostas : 0, tempoMedioMs:Math.round(Number(r.tempo_medio))
    };
  }

  for(const dia of [1, 2]){
    const [lista, est] = await Promise.all([lerPerguntas(dia), sql`
      SELECT idx, COUNT(*)::int AS respondidas, COUNT(*) FILTER (WHERE acertou)::int AS acertos, COALESCE(AVG(tempo_ms), 0) AS tempo_medio,
             COUNT(*) FILTER (WHERE alt = 0)::int AS a0, COUNT(*) FILTER (WHERE alt = 1)::int AS a1,
             COUNT(*) FILTER (WHERE alt = 2)::int AS a2, COUNT(*) FILTER (WHERE alt = 3)::int AS a3
      FROM respostas WHERE dia = ${dia} GROUP BY idx`]);
    perguntas[dia] = lista.map((q, i) => {
      const e = est.find(x => x.idx === i);
      return {
        enunciado:q.enunciado, alts:q.alts, correta:q.correta,
        respondidas:e ? e.respondidas : 0, acertos:e ? e.acertos : 0,
        taxaAcerto:e && e.respondidas ? e.acertos / e.respondidas : 0,
        tempoMedioMs:e ? Math.round(Number(e.tempo_medio)) : 0,
        escolhas:e ? [e.a0, e.a1, e.a2, e.a3] : [0, 0, 0, 0]
      };
    });
  }

  return {
    geradoEm:new Date().toISOString(), dia:diaAtual(config),
    config:{ total:config.total, tempo:config.tempo, pct:config.pct, virada:config.virada },
    jogo:{ iniciadoEm:jogo.iniciadoEm, encerradoEm:jogo.encerradoEm },
    resumo, ranking, perguntas
  };
}

async function salvarRelatorio(titulo){
  const dados = await montarRelatorio();
  const [r] = await sql`INSERT INTO relatorios(titulo, dados) VALUES(${titulo}, ${JSON.stringify(dados)}) RETURNING id`;
  return r.id;
}

/* ---------- Rotas da API ---------- */
const rotas = {
  /* Jogo: dia em vigor, quantidade de perguntas, configuração e se o jogo está aberto
     (as perguntas só saem durante a partida) */
  'GET /api/estado': async () => {
    const [config, jogo] = await Promise.all([lerConfig(), lerEstadoJogo()]);
    const dia = diaAtual(config);
    const [{ n }] = await sql`SELECT COUNT(*)::int AS n FROM perguntas WHERE dia = ${dia}`;
    return { dia, total:n, config, estado:jogo.estado };
  },

  /* Admin: situação do jogo e lista de relatórios salvos */
  'GET /api/admin/jogo': async (body, req) => {
    exigirAdmin(req);
    const [jogo, config, lista] = await Promise.all([lerEstadoJogo(), lerConfig(),
      sql`SELECT id, criado_em, titulo FROM relatorios ORDER BY id DESC LIMIT 50`]);
    return { ...jogo, dia:diaAtual(config), relatorios:lista.map(r => ({ id:r.id, criadoEm:r.criado_em, titulo:r.titulo })) };
  },

  /* Admin: INICIAR — abre o jogo para os participantes */
  'POST /api/admin/jogo/iniciar': async (body, req) => {
    exigirAdmin(req);
    const atual = await lerEstadoJogo();
    if(atual.estado === 'aberto') throw new ErroHttp(409, 'O jogo já está aberto.');
    const novo = { estado:'aberto', iniciadoEm:new Date().toISOString(), encerradoEm:null };
    await gravarEstadoJogo(novo);
    return novo;
  },

  /* Admin: ENCERRAR — fecha o jogo (ninguém mais entra nem responde) e salva o relatório para o dashboard.
     Fecha primeiro e só depois fotografa, para nenhuma resposta entrar no meio do cálculo. */
  'POST /api/admin/jogo/encerrar': async (body, req) => {
    exigirAdmin(req);
    const atual = await lerEstadoJogo();
    if(atual.estado !== 'aberto') throw new ErroHttp(409, 'O jogo não está aberto.');
    const novo = { ...atual, estado:'encerrado', encerradoEm:new Date().toISOString() };
    await gravarEstadoJogo(novo);
    const dia = diaAtual(await lerConfig());
    return { ...novo, relatorioId:await salvarRelatorio(`Encerramento (Dia ${dia})`) };
  },

  /* Admin: salva um relatório agora, sem encerrar (também serve se a fotografia do encerramento falhar) */
  'POST /api/admin/relatorios': async (body, req) => {
    exigirAdmin(req);
    return { relatorioId:await salvarRelatorio('Relatório manual') };
  },

  /* Admin: um relatório salvo (?id=N) ou o cálculo ao vivo (?id=vivo, padrão) */
  'GET /api/admin/relatorio': async (body, req) => {
    exigirAdmin(req);
    const id = new URL(req.url, 'http://localhost').searchParams.get('id') || 'vivo';
    if(id === 'vivo') return { id:null, titulo:'Ao vivo', criadoEm:new Date().toISOString(), dados:await montarRelatorio() };
    if(!/^\d{1,9}$/.test(id)) throw new ErroHttp(400, 'Relatório inválido.');
    const [r] = await sql`SELECT id, criado_em, titulo, dados FROM relatorios WHERE id = ${Number(id)}`;
    if(!r) throw new ErroHttp(404, 'Relatório não encontrado.');
    return { id:r.id, titulo:r.titulo, criadoEm:r.criado_em, dados:JSON.parse(r.dados) };
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
    exigirAberto(await lerEstadoJogo());   // fábrica fechada: nem cadastra nem entra
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

  /* Início de partida: reserva a vaga do dia (1 por matrícula). Não entrega pergunta nem liga o relógio:
     a 1ª pergunta vem de /api/partida/proxima, depois da animação de abertura. Recarregar a página não dá nova chance. */
  'POST /api/partida/iniciar': async body => {
    const matricula = normalizarMatricula(body.matricula);
    exigirAberto(await lerEstadoJogo());
    if(!await buscarJogador(matricula)) throw new ErroHttp(404, 'Matrícula não cadastrada.');
    const config = await lerConfig();
    const dia = diaAtual(config);
    if(body.dia !== dia) throw new ErroHttp(409, 'O dia do jogo mudou. Volte ao início e entre de novo.');
    const perguntas = await lerPerguntas(dia);
    if(!perguntas.length) throw new ErroHttp(409, 'Nenhuma pergunta cadastrada para este dia.');
    const r = await sql`INSERT INTO partidas(matricula, pontos, acertos, total, dia, finalizada, idx, pergunta_inicio)
                        VALUES(${matricula}, 0, 0, ${perguntas.length}, ${dia}, FALSE, 0, NULL)
                        ON CONFLICT (matricula, dia) DO NOTHING RETURNING id`;
    if(!r.length) throw new ErroHttp(409, `Você já jogou o Dia ${dia}. Cada matrícula joga uma vez por dia.`);
    return { dia, total:perguntas.length, config };
  },

  /* Resposta à pergunta atual. O servidor mede o tempo, confere a resposta e calcula os pontos;
     só então revela a alternativa certa. Errar ou estourar o tempo encerra a partida. */
  'POST /api/partida/responder': async body => {
    const { matricula, dia, cfg, p, perguntas } = await partidaEmAndamento(body);
    if(body.idx !== p.idx) throw new ErroHttp(409, 'Pergunta fora de ordem.');
    if(!p.servida) throw new ErroHttp(409, 'Esta pergunta ainda não foi aberta.');
    const alt = body.alt ?? null;
    if(alt !== null && !inteiro(alt, 0, 3)) throw new ErroHttp(400, 'Alternativa inválida.');
    const q = perguntas[p.idx];
    if(!q) throw new ErroHttp(409, 'As perguntas foram alteradas durante a partida.');

    const limiteMs = cfg.tempo * 1000, dec = Number(p.dec_ms);
    const tempoEsgotado = alt === null || dec > limiteMs + FOLGA_MS;
    const acertou = !tempoEsgotado && alt === q.correta;
    const pontos = acertou ? valorEm(cfg, p.total, dec / limiteMs) : 0;
    const gasto = tempoEsgotado ? limiteMs : Math.min(Math.round(dec), limiteMs);
    const fim = !acertou || p.idx + 1 >= p.total;

    /* só a primeira resposta a esta pergunta vale (idx confere e o relógio ainda está ligado) */
    /* a resposta também é registrada em \`respostas\` (estatísticas do dashboard), na mesma instrução: só entra se a partida foi atualizada */
    const r = await sql`WITH u AS (
        UPDATE partidas
        SET pontos = pontos + ${pontos}, acertos = acertos + ${acertou ? 1 : 0}, tempo_ms = tempo_ms + ${gasto},
            idx = idx + 1, pergunta_inicio = NULL, finalizada = ${fim}::boolean, fim = CASE WHEN ${fim}::boolean THEN now() END
        WHERE matricula = ${matricula} AND dia = ${dia} AND finalizada = FALSE AND idx = ${p.idx} AND pergunta_inicio IS NOT NULL
        RETURNING pontos, acertos
      ), ins AS (
        INSERT INTO respostas(matricula, dia, idx, alt, acertou, tempo_ms, pontos)
        SELECT ${matricula}::text, ${dia}::int, ${p.idx}::int, ${alt}::int, ${acertou}::boolean, ${gasto}::bigint, ${pontos}::bigint FROM u
      )
      SELECT pontos, acertos FROM u`;
    if(!r.length) throw new ErroHttp(409, 'Esta pergunta já foi respondida.');
    return {
      acertou, tempoEsgotado, correta:q.correta, pontos, placar:Number(r[0].pontos), acertos:r[0].acertos, fim,
      jogador: fim ? jogadorJson(await buscarJogador(matricula)) : undefined
    };
  },

  /* Entrega a próxima pergunta (a 1ª, logo após iniciar) e liga o relógio dela: a tela só chama isto quando a
     animação de abertura termina, então o tempo só corre depois que o jogador pode ver a pergunta.
     Repetir a chamada devolve a mesma pergunta sem reiniciar o relógio. */
  'POST /api/partida/proxima': async body => {
    const { matricula, dia, perguntas } = await partidaEmAndamento(body);
    const r = await sql`UPDATE partidas SET pergunta_inicio = COALESCE(pergunta_inicio, now())
                        WHERE matricula = ${matricula} AND dia = ${dia} AND finalizada = FALSE RETURNING idx`;
    const q = r.length && perguntas[r[0].idx];
    if(!q) throw new ErroHttp(409, 'Não há próxima pergunta.');
    return { idx:r[0].idx, pergunta:perguntaPublica(q) };
  },

  /* Admin: libera nova tentativa (ex.: queda de energia/internet durante a partida) */
  'POST /api/admin/liberar': async (body, req) => {
    exigirAdmin(req);
    const matricula = normalizarMatricula(body.matricula);
    if(body.dia !== 1 && body.dia !== 2) throw new ErroHttp(400, 'Dia inválido.');
    const [r] = await sql.transaction([
      sql`DELETE FROM partidas WHERE matricula = ${matricula} AND dia = ${body.dia} RETURNING id`,
      sql`DELETE FROM respostas WHERE matricula = ${matricula} AND dia = ${body.dia}`
    ]);
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
    responder(res, e.status || 500, e instanceof ErroHttp ? { erro:e.message, ...e.extra } : { erro:'Erro interno.' });
  }
  return true;
}

module.exports = { tratarApi, responder, valorEm, iniciarBanco };
