/* ==========================================================
   RUMO AO MILHÃO — servidor local de desenvolvimento
   Iniciar:  npm start   →  http://localhost:3020
   Na Vercel, public/ é servido como estático e a API roda em api/[...rota].js.
   npm start / npm run dev → sempre o banco LOCAL (PGlite em .dados-teste/dev); nunca o de produção.
   O Neon só é usado dentro da Vercel (ver lib/db.js).
   ========================================================== */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

try { process.loadEnvFile(path.join(__dirname, '.env.local')); } catch {}

const { tratarApi, responder } = require('./lib/app');

const PORTA = Number(process.env.PORT) || 3020;
const PUBLICO = path.join(__dirname, 'public');

/* Arquivos estáticos servidos (lista fechada) */
const HTML = 'text/html; charset=utf-8';
const PAGINAS = {
  '/index.html':{ tipo:HTML },
  '/jogo.html': { tipo:HTML },
  '/admin.html':{ tipo:HTML },
  '/estilo.css':{ tipo:'text/css; charset=utf-8' },
  '/common.js': { tipo:'text/javascript; charset=utf-8' }
};

const servidor = http.createServer(async (req, res) => {
  const { pathname } = new URL(req.url, 'http://localhost');
  if(req.method === 'GET'){
    const nome = pathname === '/' ? '/index.html' : pathname;
    const arq = PAGINAS[nome];
    if(arq) return responder(res, 200, fs.readFileSync(path.join(PUBLICO, nome), 'utf8'), arq.tipo);
  }
  if(!await tratarApi(req, res)) responder(res, 404, { erro:'Não encontrado.' });
}).listen(PORTA, () => console.log(`Rumo ao Milhão em http://localhost:${PORTA} — banco: LOCAL (.dados-teste)`));

module.exports = servidor;   // os testes sobem o servidor no mesmo processo (o PGlite não é compartilhável)
