/* ==========================================================
   Acesso ao banco: devolve `sql` (template tag, sql.transaction, sql.query).
   Produção: Neon (DATABASE_URL).
   Teste local: BANCO_LOCAL=1 usa o PGlite (Postgres embutido, dados numa pasta) — sem tocar no Neon.
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
  if(!process.env.DATABASE_URL){ console.error('Defina DATABASE_URL (.env.local) ou use o banco local (npm run dev).'); process.exit(1); }
  return require('@neondatabase/serverless').neon(process.env.DATABASE_URL);
}

let sql;
module.exports = new Proxy(function(){}, {
  /* criado só na primeira utilização, depois que o ambiente (.env.local, BANCO_LOCAL) foi carregado */
  get: (_, k) => (sql ??= process.env.BANCO_LOCAL === '1' ? criarLocal() : criarNeon())[k],
  apply: (_, __, args) => (sql ??= process.env.BANCO_LOCAL === '1' ? criarLocal() : criarNeon())(...args)
});
