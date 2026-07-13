// Cron da Vercel: roda o ciclo de monitoramento (importa + rastreia + regras).
// Protegido por CMP_CRON_SECRET. A Vercel Cron chama com header Authorization.
import { runCycle } from '../lib/engine.js';

export const config = { maxDuration: 60 };

// Teste READ-ONLY da Loja Integrada (?probe=li) — valida chaves e revela
// os códigos de situação reais da conta. Não escreve nada.
async function probeLI() {
  const base = process.env.LI_BASE_URL || 'https://api.awsli.com.br/v1';
  const API = process.env.LI_CHAVE_API, APP = process.env.LI_CHAVE_APLICACAO;
  const tryFetch = async (url, headers) => {
    try {
      const r = await fetch(url, { headers: { Accept: 'application/json', ...headers } });
      const t = await r.text();
      return { status: r.status, body: t.slice(0, 250) };
    } catch (e) { return { erro: e.message }; }
  };
  const variacoes = [
    { nome: 'header chave_api X chave_aplicacao Y + /pedido/', url: base + '/pedido/?limite=3', h: { Authorization: `chave_api ${API} chave_aplicacao ${APP}` } },
    { nome: 'header invertido (Y/X) + /pedido/', url: base + '/pedido/?limite=3', h: { Authorization: `chave_api ${APP} chave_aplicacao ${API}` } },
    { nome: 'sem barra final /pedido', url: base + '/pedido?limite=3', h: { Authorization: `chave_api ${API} chave_aplicacao ${APP}` } },
    { nome: 'query params chave_api/chave_aplicacao', url: `${base}/pedido/?chave_api=${API}&chave_aplicacao=${APP}&limite=3`, h: {} },
    { nome: 'headers separados', url: base + '/pedido/?limite=3', h: { 'chave_api': API, 'chave_aplicacao': APP } },
  ];
  const resultados = [];
  for (const v of variacoes) { const r = await tryFetch(v.url, v.h); resultados.push({ nome: v.nome, ...r }); }
  return { base, apiLen: (API || '').length, appLen: (APP || '').length, resultados };
}

export default async function handler(req, res) {
  const secret = process.env.CMP_CRON_SECRET;
  const provided = (req.headers.authorization || '').replace('Bearer ', '') || req.query.secret;
  const isVercelCron = !!req.headers['x-vercel-cron'];
  if (secret && !isVercelCron && provided !== secret) {
    return res.status(401).json({ error: 'não autorizado' });
  }
  try {
    if (req.query.probe === 'li') return res.status(200).json(await probeLI());
    const result = await runCycle();
    return res.status(200).json({ ok: true, ...result });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
}
