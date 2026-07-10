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
  const { code } = req.query;
  if (!code) return res.status(400).send("Falta o parametro code");

  try {
    const creds = Buffer.from(process.env.BLING_CLIENT_ID + ":" + process.env.BLING_CLIENT_SECRET).toString("base64");
    const tokRes = await fetch("https://api.bling.com.br/Api/v3/oauth/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: "Basic " + creds,
      },
      body: "grant_type=authorization_code&code=" + encodeURIComponent(code),
    });
    const d = await tokRes.json();
    if (!d.access_token || !d.refresh_token) {
      return res.status(500).json({ erro: "Falha ao trocar code por token", detalhes: d });
    }

    await salvarTokensAtomicos(d.refresh_token, d.access_token);

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    return res.send(`<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<title>Conectado</title>
<style>body{font-family:sans-serif;text-align:center;padding:40px}</style>
</head>
<body>
<h2>Conectado com sucesso ao Bling!</h2>
<p>Salvando token... voce sera redirecionado em 1s.</p>
<script>
try {
  localStorage.setItem('bling_access', JSON.stringify({
    token: ${JSON.stringify(d.access_token)},
    exp: Date.now() + 55 * 60 * 1000
  }));
} catch(_) {}
setTimeout(function(){ window.location.href = '/'; }, 1000);
</script>
</body>
</html>`);
  } catch (err) {
    return res.status(500).json({ erro: err.message });
  }
}
