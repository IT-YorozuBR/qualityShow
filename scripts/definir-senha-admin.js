/* Define a senha do admin: grava ADMIN_USER, ADMIN_HASH e ADMIN_SEGREDO no .env.local.
   Uso:  node scripts/definir-senha-admin.js
   A senha é digitada no terminal e nunca é gravada, só o hash. */
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');

const ARQ = path.join(__dirname, '..', '.env.local');
const MAPEADAS = /^(ADMIN_USER|ADMIN_HASH|ADMIN_SEGREDO)=/;

const rl = readline.createInterface({ input:process.stdin, output:process.stdout });
const perguntar = t => new Promise(r => rl.question(t, r));

(async () => {
  const usuario = (await perguntar('Usuário [admin]: ')).trim() || 'admin';
  const senha = await perguntar('Nova senha (mín. 8 caracteres): ');
  const confere = await perguntar('Repita a senha: ');
  rl.close();
  if(senha.length < 8){ console.error('Senha curta demais.'); process.exit(1); }
  if(senha !== confere){ console.error('As senhas não são iguais.'); process.exit(1); }

  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(senha.normalize('NFC'), salt, 64);
  const linhas = (fs.existsSync(ARQ) ? fs.readFileSync(ARQ, 'utf8').split(/\r?\n/) : []).filter(l => l && !MAPEADAS.test(l));
  linhas.push(`ADMIN_USER=${usuario}`, `ADMIN_HASH=${salt.toString('hex')}:${hash.toString('hex')}`, `ADMIN_SEGREDO=${crypto.randomBytes(32).toString('hex')}`);
  fs.writeFileSync(ARQ, linhas.join('\n') + '\n');
  console.log('Pronto. Reinicie o servidor (npm start).');
  console.log('Na Vercel, atualize ADMIN_USER, ADMIN_HASH e ADMIN_SEGREDO com os valores novos do .env.local.');
})();
