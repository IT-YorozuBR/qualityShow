/* ==========================================================
   RUMO AO MILHÃO — servidor local de desenvolvimento
   Iniciar:  npm start   →  http://localhost:3020
   Na Vercel, esta é a entrada da função: NÃO exporte nada daqui (o que for exportado vira o handler
   e trava a API). O atendimento das rotas fica em lib/http.js.
   npm start / npm run dev → sempre o banco LOCAL (PGlite em .dados-teste/dev); nunca o de produção.
   O Neon só é usado dentro da Vercel (ver lib/db.js).
   ========================================================== */
const http = require('node:http');
const path = require('node:path');

try { process.loadEnvFile(path.join(__dirname, '.env.local')); } catch {}

const { atender } = require('./lib/http');

const PORTA = Number(process.env.PORT) || 3020;

http.createServer(atender).listen(PORTA, () => console.log(`Rumo ao Milhão em http://localhost:${PORTA}`));
