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
  if (!ec) return process.env.BLING_REFRESH_TOKEN || null;
  try {
    const r = await fetch("https://edge-config.vercel.com/" + ec.ecId + "/item/bling_refresh_token?token=" + ec.token);
    if (r.ok) { const val = await r.json(); if (val) return val; }
  } catch (_) {}
  return process.env.BLING_REFRESH_TOKEN || null;
}

async function salvarTokensAtomicos(refreshToken, accessToken) {
  const ec = parseEC();
  if (!ec || !process.env.VERCEL_TOKEN) return false;
  const accessCache = JSON.stringify({ token: accessToken, expires: Date.now() + 55 * 60 * 1000 });
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch("https://api.vercel.com/v1/edge-config/" + ec.ecId + "/items", {
        method: "PATCH",
        headers: { Authorization: "Bearer " + process.env.VERCEL_TOKEN, "Content-Type": "application/json" },
        body: JSON.stringify({
          items: [
            { operation: "upsert", key: "bling_refresh_token", value: refreshToken },
            { operation: "upsert", key: "bling_access_cache", value: accessCache }
          ]
        }),
      });
      if (r.ok) return true;
    } catch (_) {}
    if (i < 2) await new Promise(res => setTimeout(res, 200));
  }
  return false;
}

export default async function handler(req, res) {
  // Vercel Cron envia o header Authorization automaticamente
  const cronAuth = req.headers["authorization"];
  const isCron = cronAuth && process.env.CRON_SECRET && cronAuth === ("Bearer " + process.env.CRON_SECRET);
  const isManual = req.query.manual === "1";

  try {
    const refreshToken = await lerRefreshToken();
    if (!refreshToken) {
      return res.status(400).json({ ok: false, erro: "Sem refresh_token. Acesse /api/setup." });
    }

    const creds = Buffer.from(process.env.BLING_CLIENT_ID + ":" + process.env.BLING_CLIENT_SECRET).toString("base64");
    const r = await fetch("https://api.bling.com.br/Api/v3/oauth/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: "Basic " + creds,
      },
      body: "grant_type=refresh_token&refresh_token=" + encodeURIComponent(refreshToken),
    });
    const d = await r.json();

    if (!d.access_token) {
      return res.status(500).json({ ok: false, erro: "Bling rejeitou refresh", detalhes: d, hint: "Acesse /api/setup para reconectar." });
    }

    const novoRefresh = d.refresh_token || refreshToken;
    const saved = await salvarTokensAtomicos(novoRefresh, d.access_token);

    return res.json({
      ok: true,
      saved,
      isCron,
      isManual,
      expires_in: d.expires_in,
      refresh_rotated: d.refresh_token && d.refresh_token !== refreshToken,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    return res.status(500).json({ ok: false, erro: err.message });
  }
}
