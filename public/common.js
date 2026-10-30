/* RUMO AO MILHÃO — código compartilhado entre as páginas (API, utilitários, pontuação) */
/* ---------- Dados (carregados do banco ao abrir a página) ---------- */
const perguntas = [];
const config = { total:1000000, tempo:90, pct:[100,60,30], virada:null };
let diaEdicao = 1;   // admin: dia cujas perguntas estão em edição

const LETRAS = ['A','B','C','D'];

/* ---------- Utilitários ---------- */
const $ = id => document.getElementById(id);

/* Token do administrador (guardado só enquanto a aba estiver aberta) */
function cabecalhoAdmin(){
  let t = null;
  try { t = sessionStorage.getItem('adminToken'); } catch {}
  return t ? { Authorization:'Bearer ' + t } : {};
}

/* Chamada à API; lança Error com a mensagem do servidor em caso de falha */
async function api(metodo, url, corpo){
  let r;
  try {
    r = await fetch(url, {
      method:metodo,
      headers:{ 'Content-Type':'application/json', ...cabecalhoAdmin() },
      body: corpo === undefined ? undefined : JSON.stringify(corpo)
    });
  } catch { throw new Error('Sem conexão com o servidor.'); }
  const dados = await r.json().catch(() => ({}));
  if(!r.ok) throw Object.assign(new Error(dados.erro || 'Erro no servidor.'), { status:r.status });
  return dados;
}

/* Grava perguntas/configuração no banco; falhas aparecem no painel (admin.html) */
function salvarPerguntas(){
  api('PUT', '/api/perguntas', { dia:diaEdicao, perguntas }).catch(e => avisoPainel(e.message));
}
let cfgTimer = null;
function salvarConfig(){
  clearTimeout(cfgTimer);
  cfgTimer = setTimeout(() => api('PUT', '/api/config', { config }).catch(e => avisoPainel(e.message)), 400);
}
const fmt = n => Math.round(n).toLocaleString('pt-BR');
const esc = s => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const espera = ms => new Promise(r => setTimeout(r, ms));

/* Pontos máximos por pergunta e valor de cada faixa.
   No jogo, as perguntas ficam no servidor e a página só sabe quantas são (totalPerguntas). */
let totalPerguntas = null;
function pontosPorPergunta(){ const n = totalPerguntas ?? perguntas.length; return n ? config.total / n : 0; }
function valorFaixa(i){ return valorEm(i / 3); }

/* Pontos em função do tempo gasto (frac = 0 no início, 1 no fim): a pontuação desce de forma contínua,
   passando por pct[0] no início, pct[1] na metade e pct[2] no fim. Assim quase nunca há dois jogadores com o mesmo valor.
   Aqui só serve para mostrar o "Valendo"; quem calcula os pontos de verdade é o servidor (lib/app.js). */
function valorEm(frac){
  const f = Math.max(0, Math.min(1, frac)), [a, b, c] = config.pct;
  const pct = f <= .5 ? a + (b - a) * (f / .5) : b + (c - b) * ((f - .5) / .5);
  return Math.round(pontosPorPergunta() * pct / 100);
}
