// api/estoque-sync.js
// Sistema de Reposição Inteligente — sondagem/sync de estoque (Bling) + fotos (Loja Integrada).
//
// FASE ATUAL: sondagem (?debug=...). Ainda NÃO grava nada — só inspeciona o formato real
// dos dados pra construir o sync de verdade em cima disso.
//   /api/estoque-sync?debug=bling-prod        -> 3 produtos do Bling (campos, sku, saldo, imagem)
//   /api/estoque-sync?debug=bling-estoque&id= -> saldo de estoque de um produto no Bling
//   /api/estoque-sync?debug=li-prod           -> 3 produtos da Loja Integrada (foco: imagem)
//
// Bling: OAuth (mesmo esquema do api/pedidos.js). LI: chave_api/chave_aplicacao por query.

// ---------------- Bling token (mesmo esquema do api/pedidos.js) ----------------
const PROJ = "prj_ErH4xc9FokreQHv0utp1xJ2eGvdO";
const TEAM = "team_Hv0Wqku1l7HhDDiJZmR2u5Ze";
function parseEC() {
  try {
    const u = new URL(process.env.EDGE_CONFIG || "");
    const ecId = u.pathname.replace(/^\//, "");
    const token = u.searchParams.get("token");
    return ecId && token ? { ecId, token } : null;
  } catch (_) { return null; }
}
async function lerRefreshToken() {
  const ec = parseEC();
  if (ec) {
    try {
      const r = await fetch("https://edge-config.vercel.com/" + ec.ecId + "/item/bling_refresh_token?token=" + ec.token);
      if (r.ok) { const val = await r.json(); if (val) return val; }
    } catch (_) {}
  }
  return process.env.BLING_REFRESH_TOKEN || null;
}
async function lerAccessTokenCache() {
  const ec = parseEC();
  if (!ec) return null;
  try {
    const r = await fetch("https://edge-config.vercel.com/" + ec.ecId + "/item/bling_access_cache?token=" + ec.token);
    if (!r.ok) return null;
    const raw = await r.json();
    if (!raw) return null;
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (parsed && parsed.token && parsed.expires && Date.now() < parsed.expires) return parsed.token;
  } catch (_) {}
  return null;
}
async function salvarAccessTokenCache(accessToken) {
  const ec = parseEC();
  if (!ec || !process.env.VERCEL_TOKEN) return;
  const cache = JSON.stringify({ token: accessToken, expires: Date.now() + 55 * 60 * 1000 });
  try {
    await fetch("https://api.vercel.com/v1/edge-config/" + ec.ecId + "/items", {
      method: "PATCH",
      headers: { Authorization: "Bearer " + process.env.VERCEL_TOKEN, "Content-Type": "application/json" },
      body: JSON.stringify({ items: [{ operation: "upsert", key: "bling_access_cache", value: cache }] }),
    });
  } catch (_) {}
}
async function getBlingToken() {
  const cached = await lerAccessTokenCache();
  if (cached) return cached;
  const refreshToken = await lerRefreshToken();
  if (!refreshToken) throw new Error("Token Bling invalido. Reconecte em /api/setup.");
  const creds = Buffer.from(process.env.BLING_CLIENT_ID + ":" + process.env.BLING_CLIENT_SECRET).toString("base64");
  const r = await fetch("https://api.bling.com.br/Api/v3/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: "Basic " + creds },
    body: "grant_type=refresh_token&refresh_token=" + encodeURIComponent(refreshToken),
  });
  const d = await r.json();
  if (!d.access_token) throw new Error("Falha no refresh do Bling.");
  salvarAccessTokenCache(d.access_token);
  return d.access_token;
}
async function bling(path, token) {
  const r = await fetch("https://api.bling.com.br/Api/v3" + path, { headers: { Authorization: "Bearer " + token } });
  const d = await r.json().catch(() => null);
  return { ok: r.ok, status: r.status, data: d };
}

// ---------------- Loja Integrada (API v1, chaves por query) ----------------
async function li(path) {
  const base = process.env.LI_BASE_URL || "https://api.awsli.com.br/v1";
  const u = new URL(path.startsWith("http") ? path : base + path);
  u.searchParams.set("chave_api", process.env.LI_CHAVE_API || "");
  u.searchParams.set("chave_aplicacao", process.env.LI_CHAVE_APLICACAO || "");
  const r = await fetch(u.toString(), { headers: { Accept: "application/json" } });
  const d = await r.json().catch(() => null);
  return { ok: r.ok, status: r.status, data: d };
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  const debug = req.query.debug;
  try {
    if (debug === "bling-prod") {
      const token = await getBlingToken();
      const limite = req.query.limite || 3;
      const out = await bling("/produtos?pagina=1&limite=" + limite, token);
      return res.json({ fonte: "bling /produtos", status: out.status, amostra: (out.data && out.data.data) || out.data });
    }
    if (debug === "bling-estoque") {
      const token = await getBlingToken();
      const id = req.query.id;
      const path = id ? "/estoques/saldos?idsProdutos[]=" + id : "/estoques/saldos";
      const out = await bling(path, token);
      return res.json({ fonte: "bling /estoques/saldos", status: out.status, amostra: (out.data && out.data.data) || out.data });
    }
    if (debug === "li-prod") {
      const limit = req.query.limit || 3;
      const out = await li("/produto/?limit=" + limit);
      const objs = (out.data && (out.data.objects || out.data.results)) || out.data;
      return res.json({ fonte: "LI /produto/", status: out.status, amostra: objs });
    }
    return res.json({ ok: true, uso: ["?debug=bling-prod", "?debug=bling-estoque&id=", "?debug=li-prod"] });
  } catch (err) {
    return res.status(500).json({ erro: err.message });
  }
}
