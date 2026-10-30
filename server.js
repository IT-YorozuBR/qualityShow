/* ==========================================================
   RUMO AO MILHÃO — servidor local de desenvolvimento
   Iniciar:  npm start   →  http://localhost:3020
   Na Vercel, public/ é servido como estático e a API roda em api/[...rota].js.
   Lê DATABASE_URL de .env.local.
   ========================================================== */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

try { process.loadEnvFile(path.join(__dirname, '.env.local')); } catch {}
if(!process.env.DATABASE_URL){ console.error('Defina DATABASE_URL (arquivo .env.local).'); process.exit(1); }

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

http.createServer(async (req, res) => {
  const { pathname } = new URL(req.url, 'http://localhost');
  if(req.method === 'GET'){
    const nome = pathname === '/' ? '/index.html' : pathname;
    const arq = PAGINAS[nome];
    if(arq) return responder(res, 200, fs.readFileSync(path.join(PUBLICO, nome), 'utf8'), arq.tipo);
  }
  if(!await tratarApi(req, res)) responder(res, 404, { erro:'Não encontrado.' });
}).listen(PORTA, () => console.log(`Rumo ao Milhão em http://localhost:${PORTA}`));
