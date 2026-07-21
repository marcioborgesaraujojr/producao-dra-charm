// lib/licfg.js — Fonte única das chaves da Loja Integrada.
// Lê do Edge Config (li_chave_api / li_chave_aplicacao) e, se não houver
// ou der erro, cai no process.env. Assim, sem nada configurado no Edge Config,
// o comportamento é IDÊNTICO ao de hoje (nada quebra).
// Cache em memória com TTL curto para não bater no Edge Config a cada chamada.

function parseEC() {
  try {
    const u = new URL(process.env.EDGE_CONFIG || '');
    const ecId = u.pathname.replace(/^\//, '');
    const token = u.searchParams.get('token');
    return ecId && token ? { ecId, token } : null;
  } catch (_) { return null; }
}

async function ecItem(ec, key) {
  try {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), 4000);
    let v = null;
    try {
      const r = await fetch('https://edge-config.vercel.com/' + ec.ecId + '/item/' + key + '?token=' + ec.token, { signal: c.signal });
      if (r.ok) { const j = await r.json(); if (j) v = typeof j === 'string' ? j : String(j); }
    } finally { clearTimeout(t); }
    return v;
  } catch (_) { return null; }
}

let _cache = null;        // { api, app }
let _cacheAt = 0;
const TTL = 60 * 1000;    // 60s

export async function getLIKeys() {
  const envApi = process.env.LI_CHAVE_API || '';
  const envApp = process.env.LI_CHAVE_APLICACAO || '';
  const now = Date.now();
  if (_cache && (now - _cacheAt) < TTL) return _cache;
  let api = envApi, app = envApp;
  const ec = parseEC();
  if (ec) {
    const [a, p] = await Promise.all([ecItem(ec, 'li_chave_api'), ecItem(ec, 'li_chave_aplicacao')]);
    if (a) api = a;
    if (p) app = p;
  }
  _cache = { api, app };
  _cacheAt = now;
  return _cache;
}

// Invalida o cache (usado logo após gravar novas chaves).
export function invalidateLIKeys() { _cache = null; _cacheAt = 0; }

// ===== Chave da Anthropic (Assistente IA) — mesmo esquema: Edge Config + fallback env =====
let _antKey = undefined;   // undefined = ainda não lido; string|'' depois
let _antAt = 0;
export async function getAnthropicKey() {
  const env = process.env.ANTHROPIC_API_KEY || '';
  const now = Date.now();
  if (_antKey !== undefined && (now - _antAt) < TTL) return _antKey;
  let key = env;
  const ec = parseEC();
  if (ec) { const v = await ecItem(ec, 'anthropic_api_key'); if (v) key = v; }
  _antKey = key;
  _antAt = now;
  return _antKey;
}
export function invalidateAnthropicKey() { _antKey = undefined; _antAt = 0; }

export default { getLIKeys, invalidateLIKeys, getAnthropicKey, invalidateAnthropicKey };
