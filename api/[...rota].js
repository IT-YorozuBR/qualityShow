/* Função da Vercel: atende todas as rotas /api/* */
const { tratarApi, responder } = require('../lib/app');

module.exports = async (req, res) => {
  if(!await tratarApi(req, res)) responder(res, 404, { erro:'Não encontrado.' });
};
