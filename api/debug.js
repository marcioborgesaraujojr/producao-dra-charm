async function getToken() {
    const id = process.env.BLING_CLIENT_ID;
    const secret = process.env.BLING_CLIENT_SECRET;
    const refresh = process.env.BLING_REFRESH_TOKEN;
    const creds = Buffer.from(id + ":" + secret).toString("base64");
    const r = await fetch("https://www.bling.com.br/Api/v3/oauth/token", {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded", "Authorization": "Basic " + creds },
                body: "grant_type=refresh_token&refresh_token=" + encodeURIComponent(refresh)
    });
    const d = await r.json();
    if (d.refresh_token) {
          fetch("https://api.vercel.com/v9/projects/prj_ErH4xc9FokreQHv0utp1xJ2eGvdO/env/z4YNrp6AOlO8heUG?teamId=team_Hv0Wqku1l7HhDDiJZmR2u5Ze", {
                  method: "PATCH",
                  headers: { "Authorization": "Bearer " + process.env.VERCEL_TOKEN, "Content-Type": "application/json" },
                          body: JSON.stringify({ value: d.refresh_token })
          }).catch(() => {});
    }
    return d.access_token;
}

export default async function handler(req, res) {
    res.setHeader("Access-Control-Allow-Origin", "*");
    try {
          const token = await getToken();
          const hoje = new Date().toISOString().slice(0, 10);
          const listR = await fetch("https://www.bling.com.br/Api/v3/pedidos/vendas?dataInicial=" + hoje + "&dataFinal=" + hoje + "&pagina=1&limite=1", {
                  headers: { "Authorization": "Bearer " + token }
          });
          const listD = await listR.json();
          const firstId = listD.data && listD.data[0] && listD.data[0].id;
          if (!firstId) return res.json({ lista_sample: listD.data && listD.data[0], erro: "sem pedidos hoje" });
          const detR = await fetch("https://www.bling.com.br/Api/v3/pedidos/vendas/" + firstId, {
                  headers: { "Authorization": "Bearer " + token }
          });
          const detD = await detR.json();
          return res.json({ id: firstId, lista_campos: listD.data[0], detalhe_campos: detD.data });
    } catch(e) { res.status(500).json({ erro: e.message }); }
}
