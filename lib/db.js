/* ==========================================================
   Acesso ao banco: devolve `sql` (template tag, sql.transaction, sql.query).
   O Neon (produção) só é usado quando o código roda NA VERCEL (a Vercel define VERCEL=1 e DATABASE_URL).
   Em qualquer outro lugar — npm start, npm run dev, testes, scripts — o banco é SEMPRE o local (PGlite,
   dados em .dados-teste/), mesmo que exista DATABASE_URL em .env.local. Não há chave para mudar isso.
   ========================================================== */
const path = require('node:path');

function criarLocal(){
  /* nome montado em runtime para a Vercel não empacotar o PGlite (só serve ao desenvolvimento) */
  const { PGlite, types } = require(['@electric-sql', 'pglite'].join('/'));
  const pasta = process.env.BANCO_LOCAL_DIR || path.join(__dirname, '..', '.dados-teste', 'dev');
  require('node:fs').mkdirSync(path.dirname(pasta), { recursive:true });
  const db = new PGlite(pasta);
  const opcoes = { parsers:{ [types.INT8]:v => v } };   // BIGINT como texto, igual ao driver do Neon
  const executar = (texto, params) => db.query(texto, params, opcoes).then(r => r.rows);
  /* consulta preguiçosa (só roda quando aguardada ou dentro de transaction), como no Neon */
  const consulta = (texto, params) => ({ texto, params, then:(ok, erro) => executar(texto, params).then(ok, erro) });

  const sql = (partes, ...valores) => consulta(partes.reduce((t, p, i) => t + (i ? '$' + i : '') + p, ''), valores);
  sql.query = executar;
  sql.transaction = consultas => db.transaction(async tx => {
    const saidas = [];
    for(const q of consultas) saidas.push((await tx.query(q.texto, q.params, opcoes)).rows);
    return saidas;
  });
  return sql;
}

function criarNeon(){
  if(!process.env.DATABASE_URL) throw new Error('DATABASE_URL não definida nas variáveis de ambiente da Vercel.');
  return require('@neondatabase/serverless').neon(process.env.DATABASE_URL);
}

/* true só na Vercel */
const naVercel = () => !!process.env.VERCEL;
let sql;
module.exports = new Proxy(function(){}, {
  /* criado só na primeira utilização, depois que o ambiente (.env.local) foi carregado */
  get: (_, k) => (sql ??= naVercel() ? criarNeon() : criarLocal())[k],
  apply: (_, __, args) => (sql ??= naVercel() ? criarNeon() : criarLocal())(...args)
});
