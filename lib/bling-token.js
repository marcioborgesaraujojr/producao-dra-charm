// lib/bling-token.js — o ÚNICO lugar que renova o token do Bling.
//
// Este código morava dentro do api/estoque-sync.js e funcionava bem, porque lá só um cron
// por dia o chamava. Ao trazer o Bling pro caminho de resposta do robô, ter duas cópias
// disto viraria bomba: o refresh token do Bling ROTACIONA — cada renovação invalida a
// anterior —, então duas implementações renovando por conta própria acabam derrubando a
// integração inteira (estoque diário e pedidos), não só o robô.
//
// Por isso saiu de lá e virou este arquivo, importado pelos dois. Não é refatoração por
// gosto: é reduzir a UM o número de coisas que sabem rotacionar o token.
//
// Regra de quem consome: só o cron renova. O robô lê o cache (lib/bling.js) e, se estiver
// frio, usa o retrato do dia.

function parseEC() {
  try {
    const u = new URL(process.env.EDGE_CONFIG || '');
    const ecId = u.pathname.replace(/^\//, '');
    const token = u.searchParams.get('token');
    return ecId && token ? { ecId, token } : null;
  } catch (e) { return null; }
}

async function lerRefreshToken() {
  const ec = parseEC();
  if (ec) {
    try {
      const r = await fetch('https://edge-config.vercel.com/' + ec.ecId + '/item/bling_refresh_token?token=' + ec.token);
      if (r.ok) { const val = await r.json(); if (val) return val; }
    } catch (e) {}
  }
  return process.env.BLING_REFRESH_TOKEN || null;
}

async function gravarNoEdgeConfig(chave, valor) {
  const ec = parseEC();
  if (!ec || !process.env.VERCEL_TOKEN) return false;
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch('https://api.vercel.com/v1/edge-config/' + ec.ecId + '/items', {
        method: 'PATCH',
        headers: { Authorization: 'Bearer ' + process.env.VERCEL_TOKEN, 'Content-Type': 'application/json' },
        body: JSON.stringify({ items: [{ operation: 'upsert', key: chave, value: valor }] }),
      });
      if (r.ok) return true;
    } catch (e) {}
    if (i < 2) await new Promise((res) => setTimeout(res, 200));
  }
  return false;
}

async function lerAccessTokenCache() {
  const ec = parseEC();
  if (!ec) return null;
  try {
    const r = await fetch('https://edge-config.vercel.com/' + ec.ecId + '/item/bling_access_cache?token=' + ec.token);
    if (!r.ok) return null;
    const raw = await r.json();
    if (!raw) return null;
    const p = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (p && p.token && p.expires && Date.now() < p.expires) return p.token;
  } catch (e) {}
  return null;
}

/**
 * Devolve um access token válido, renovando se precisar.
 * Só o cron deve chamar isto. Lança quando não dá pra renovar — quem chama decide.
 */
export async function getBlingToken() {
  const cached = await lerAccessTokenCache();
  if (cached) return cached;

  const refreshToken = await lerRefreshToken();
  if (!refreshToken) throw new Error('Token Bling invalido. Reconecte em /api/setup.');

  const creds = Buffer.from(process.env.BLING_CLIENT_ID + ':' + process.env.BLING_CLIENT_SECRET).toString('base64');
  const r = await fetch('https://api.bling.com.br/Api/v3/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: 'Basic ' + creds },
    body: 'grant_type=refresh_token&refresh_token=' + encodeURIComponent(refreshToken),
  });
  const d = await r.json();
  if (!d.access_token) throw new Error('Falha no refresh do Bling.');

  /* A ordem importa: o refresh token novo PRIMEIRO. Se o processo morrer entre as duas
     gravações, perder o access cache custa uma renovação; perder o refresh novo custa
     reconectar o Bling na mão. */
  if (d.refresh_token && d.refresh_token !== refreshToken) await gravarNoEdgeConfig('bling_refresh_token', d.refresh_token);
  await gravarNoEdgeConfig('bling_access_cache', JSON.stringify({ token: d.access_token, expires: Date.now() + 55 * 60 * 1000 }));
  return d.access_token;
}
