/* Atendimento HTTP do servidor local: páginas estáticas de public/ + API.
   Fica aqui (e não em server.js) para os testes subirem um servidor no mesmo processo
   sem que server.js precise exportar nada — na Vercel, o que server.js exporta vira o handler da função. */
const fs = require('node:fs');
const path = require('node:path');
const { tratarApi, responder } = require('./app');

const PUBLICO = path.join(__dirname, '..', 'public');

/* Arquivos estáticos servidos (lista fechada) */
const HTML = 'text/html; charset=utf-8';
const PAGINAS = {
  '/index.html':{ tipo:HTML },
  '/jogo.html': { tipo:HTML },
  '/admin.html':{ tipo:HTML },
  '/estilo.css':{ tipo:'text/css; charset=utf-8' },
  '/common.js': { tipo:'text/javascript; charset=utf-8' }
};

async function atender(req, res){
  const { pathname } = new URL(req.url, 'http://localhost');
  if(req.method === 'GET'){
    const nome = pathname === '/' ? '/index.html' : pathname;
    const arq = PAGINAS[nome];
    if(arq) return responder(res, 200, fs.readFileSync(path.join(PUBLICO, nome), 'utf8'), arq.tipo);
  }
  if(!await tratarApi(req, res)) responder(res, 404, { erro:'Não encontrado.' });
}

module.exports = { atender };
