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

async function salvarRefreshToken(novoToken) {
const ec = parseEC();
if (ec && process.env.VERCEL_TOKEN) {
for (let i = 0; i < 3; i++) {
try {
const r = await fetch("https://api.vercel.com/v1/edge-config/" + ec.ecId + "/items", {
method: "PATCH",
headers: { Authorization: "Bearer " + process.env.VERCEL_TOKEN, "Content-Type": "application/json" },
body: JSON.stringify({ items: [{ operation: "upsert", key: "bling_refresh_token", value: novoToken }] }),
});
if (r.ok) return;
} catch (_) {}
if (i < 2) await new Promise(res => setTimeout(res, 200));
}
}
const envId = process.env.VERCEL_ENV_ID;
if (envId && process.env.VERCEL_TOKEN) {
try {
await fetch("https://api.vercel.com/v9/projects/" + PROJ + "/env/" + envId + "?teamId=" + TEAM, {
method: "PATCH",
headers: { Authorization: "Bearer " + process.env.VERCEL_TOKEN, "Content-Type": "application/json" },
body: JSON.stringify({ value: novoToken }),
});
} catch (_) {}
}
}

async function getAccessToken() {
const cached = await lerAccessTokenCache();
if (cached) return cached;
const refreshToken = await lerRefreshToken();
if (!refreshToken) throw new Error("Token Bling invalido. Acesse /api/setup para reconectar.");
const creds = Buffer.from(process.env.BLING_CLIENT_ID + ":" + process.env.BLING_CLIENT_SECRET).toString("base64");
const r = await fetch("https://api.bling.com.br/Api/v3/oauth/token", {
method: "POST",
headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: "Basic " + creds },
body: "grant_type=refresh_token&refresh_token=" + encodeURIComponent(refreshToken),
});
const d = await r.json();
if (!d.access_token) throw new Error("Token Bling invalido. Acesse /api/setup para reconectar.");
if (d.refresh_token && d.refresh_token !== refreshToken) await salvarRefreshToken(d.refresh_token);
salvarAccessTokenCache(d.access_token);
return d.access_token;
}

function extrairEndereco(det) {
const etiqueta = (det.transporte && det.transporte.etiqueta) || {};
const transpContato = (det.transporte && det.transporte.contato) || {};
const dest = [etiqueta, transpContato].find(d => d && d.cep) || etiqueta || {};
return {
cep: (dest.cep || "").replace(/\D/g, ""),
endereco: dest.endereco || "",
numero: dest.numero || "",
complemento: dest.complemento || "",
bairro: dest.bairro || "",
cidade: dest.municipio || "",
estado: dest.uf || "",
};
}

export default async function handler(req, res) {
res.setHeader("Access-Control-Allow-Origin", "*");
if (req.method === "OPTIONS") return res.status(200).end();

const { id, token: passedToken, data_inicio, data_fim, pagina = 1 } = req.query;

if (id) {
const token = passedToken || await getAccessToken();
try {
const blingRes = await fetch("https://api.bling.com.br/Api/v3/pedidos/vendas/" + id, {
headers: { Authorization: "Bearer " + token },
});
const d = await blingRes.json();
if (req.query._debug) {
const transp = (d.data || {}).transporte || {};
return res.json({ status: blingRes.status, has_data: !!d.data, data_keys: d.data ? Object.keys(d.data) : [], transporte_keys: Object.keys(transp), etiqueta: transp.etiqueta || null, ec_ok: !!parseEC() });
}
if (!blingRes.ok) return res.status(blingRes.status).json({ erro: "Bling " + blingRes.status, detalhes: d });
return res.json(extrairEndereco(d.data || {}));
} catch (err) {
return res.status(500).json({ erro: err.message });
}
}

if (!data_inicio || !data_fim) return res.status(400).json({ erro: "data_inicio e data_fim obrigatorios" });

try {
const token = passedToken || await getAccessToken();
const paramsObj = { dataInicial: data_inicio, dataFinal: data_fim, pagina, limite: 100 };
const situacaoId = req.query.situacao_id;
const situacaoNome = req.query.situacao;
const SITUACOES_LEGADO = { em_aberto: 6, atendido: 9, cancelado: 12, em_andamento: 15 };
if (situacaoId) { paramsObj.idSituacao = situacaoId; }
else if (situacaoNome && SITUACOES_LEGADO[situacaoNome]) { paramsObj.idSituacao = SITUACOES_LEGADO[situacaoNome]; }
const params = new URLSearchParams(paramsObj);
const r = await fetch("https://api.bling.com.br/Api/v3/pedidos/vendas?" + params, {
headers: { Authorization: "Bearer " + token },
});
const d = await r.json();
if (!r.ok) return res.status(r.status).json({ erro: "Bling API " + r.status, detalhes: d });
const lista = d.data || [];
const pedidos = lista.map(p => ({
id: p.id,
numero: p.numero,
numeroLI: p.numeroPedidoCompra || p.numeroLoja || "",
cliente: (p.contato && p.contato.nome) || "",
telefone: (p.contato && (p.contato.telefone || p.contato.celular)) || "",
situacao_id: (p.situacao && p.situacao.id) || null,
data: p.data || "",
}));
return res.json({ pagina: Number(pagina), pedidos, hasMore: lista.length === 100, _t: token });
} catch (err) {
return res.status(500).json({ erro: err.message });
}
}
