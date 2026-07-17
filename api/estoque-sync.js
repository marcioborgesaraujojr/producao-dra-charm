// api/estoque-sync.js
// Sistema de Análise de Estoque e Vendas — sync do Bling (estoque) + Loja Integrada (vendas/fotos).
// Guarda os resultados como JSON no Storage do Supabase (bucket system-assets/reposicao/*),
// então NÃO precisa de tabelas novas no banco. O front lê esses JSON públicos.
//
// Rotas:
//   ?run=estoque              -> varre produtos+estoque do Bling -> reposicao/estoque.json
//   ?run=vendas&pages=20      -> varre cabeçalhos de pedidos da LI (backfill/diário) -> reposicao/vendas.json
//   ?run=status               -> mostra o progresso atual (lê os JSON)
//   ?debug=bling-prod | li-prod | li-pedidos | li-img&id= ...   (sondagem)

// ============ Bling (OAuth, mesmo esquema do api/pedidos.js) ============
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

// ============ Loja Integrada (API v1, chaves por query) ============
async function li(path) {
  const base = process.env.LI_BASE_URL || "https://api.awsli.com.br/v1";
  const u = new URL(path.startsWith("http") ? path : base + path);
  u.searchParams.set("chave_api", process.env.LI_CHAVE_API || "");
  u.searchParams.set("chave_aplicacao", process.env.LI_CHAVE_APLICACAO || "");
  const r = await fetch(u.toString(), { headers: { Accept: "application/json" } });
  const d = await r.json().catch(() => null);
  return { ok: r.ok, status: r.status, data: d };
}

// ============ Storage do Supabase (grava/le JSON via service_role) ============
const SB_URL = () => (process.env.SUPABASE_URL || "").replace(/\/+$/, "");
const SB_KEY = () => process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const BUCKET = "reposicao-data"; // bucket próprio (público, aceita JSON)
let _bucketOk = false;
async function ensureBucket() {
  if (_bucketOk) return;
  // cria o bucket se não existir (público, sem restrição de mime -> aceita JSON)
  try {
    await fetch(SB_URL() + "/storage/v1/bucket", {
      method: "POST",
      headers: { apikey: SB_KEY(), Authorization: "Bearer " + SB_KEY(), "Content-Type": "application/json" },
      body: JSON.stringify({ id: BUCKET, name: BUCKET, public: true }),
    });
  } catch (_) {}
  _bucketOk = true;
}
async function storagePut(path, obj) {
  await ensureBucket();
  const r = await fetch(SB_URL() + "/storage/v1/object/" + BUCKET + "/" + path, {
    method: "POST",
    headers: { apikey: SB_KEY(), Authorization: "Bearer " + SB_KEY(), "Content-Type": "application/json", "x-upsert": "true" },
    body: JSON.stringify(obj),
  });
  if (!r.ok) throw new Error("Storage PUT " + r.status + ": " + (await r.text()).slice(0, 200));
  return true;
}
async function storageGet(path) {
  const r = await fetch(SB_URL() + "/storage/v1/object/" + BUCKET + "/" + path, {
    headers: { apikey: SB_KEY(), Authorization: "Bearer " + SB_KEY() },
  });
  if (!r.ok) return null;
  return r.json().catch(() => null);
}

// ============ SYNC ESTOQUE (Bling) ============
async function runEstoque() {
  const token = await getBlingToken();
  const produtos = [];
  let pagina = 1;
  const LIMITE = 100, MAX_PAGINAS = 60; // teto de segurança
  while (pagina <= MAX_PAGINAS) {
    const out = await bling("/produtos?pagina=" + pagina + "&limite=" + LIMITE + "&criterio=2", token);
    const lista = (out.data && out.data.data) || [];
    if (!lista.length) break;
    for (const p of lista) {
      produtos.push({
        sku: p.codigo || String(p.id),
        nome: p.nome || "",
        pai: p.idProdutoPai || null,
        preco: Number(p.preco || 0),
        custo: Number(p.precoCusto || 0),
        saldo: Number((p.estoque && (p.estoque.saldoVirtualTotal ?? p.estoque.saldoFisicoTotal)) || 0),
        ativo: (p.situacao || "A") === "A",
      });
    }
    if (lista.length < LIMITE) break;
    pagina++;
  }
  const snap = { atualizado_em: new Date().toISOString(), total: produtos.length, produtos };
  await storagePut("reposicao/estoque.json", snap);
  return { ok: true, total: produtos.length, paginas: pagina };
}

// ============ SYNC VENDAS (LI, cabeçalhos) — backfill + diário ============
function diaISO(dt) { return (dt || "").slice(0, 10); }
function diasAtras(n) { return new Date(Date.now() - n * 864e5).toISOString().slice(0, 10); }
function agregaPedido(dias, p) {
  const dia = diaISO(p.data_criacao);
  if (!dia) return;
  const sit = p.situacao || {};
  const pago = !!sit.aprovado && !sit.cancelado;
  const d = dias[dia] || { pedidos: 0, pagos: 0, cancelados: 0, receita: 0, receita_paga: 0 };
  d.pedidos += 1;
  if (sit.cancelado) d.cancelados += 1;
  if (pago) { d.pagos += 1; d.receita_paga += Number(p.valor_total || 0); }
  d.receita += Number(p.valor_total || 0);
  dias[dia] = d;
}
async function runVendas(maxPages) {
  maxPages = Math.min(Math.max(parseInt(maxPages) || 20, 1), 60);
  let snap = (await storageGet("reposicao/vendas.json")) || { atualizado_em: null, offset: null, total_count: 0, dias: {}, done: false, janela_dias: 365 };
  if (!snap.dias) snap.dias = {};
  const LIMIT = 100;
  const corte = diasAtras(snap.janela_dias || 365); // 'YYYY-MM-DD'
  // total de pedidos (pra começar do fim = mais recentes). Pedidos vêm do mais ANTIGO pro mais novo.
  if (!snap.total_count) {
    const head = await li("/pedido/?limit=1");
    snap.total_count = (head.data && head.data.meta && head.data.meta.total_count) || 0;
  }
  const modo = snap.done ? "incremental" : "backfill";
  // No incremental, recontar só os últimos 3 dias: zera esses dias antes.
  if (modo === "incremental") { const inc = diasAtras(3); for (const k of Object.keys(snap.dias)) if (k >= inc) delete snap.dias[k]; }
  // offset: começa do fim (registros mais novos) e vai voltando de LIMIT em LIMIT.
  let offset = (modo === "backfill" && snap.offset != null) ? snap.offset : Math.max(0, snap.total_count - LIMIT);
  let processados = 0;
  for (let i = 0; i < maxPages; i++) {
    const out = await li("/pedido/?limit=" + LIMIT + "&offset=" + offset);
    if (!out.ok || !out.data) break;
    if (out.data.meta && out.data.meta.total_count) snap.total_count = out.data.meta.total_count;
    const objs = out.data.objects || [];
    let paginaTodaAntiga = objs.length > 0;
    for (const p of objs) {
      const dia = diaISO(p.data_criacao);
      if (dia && dia >= corte) { agregaPedido(snap.dias, p); processados++; paginaTodaAntiga = false; }
    }
    if (offset === 0) { snap.done = true; break; }                 // chegou no começo de tudo
    if (paginaTodaAntiga && modo === "backfill") { snap.done = true; break; } // passou de 1 ano
    offset = Math.max(0, offset - LIMIT);
    if (modo === "incremental" && i >= 2) break;                   // incremental: só as páginas recentes
  }
  if (modo === "backfill") snap.offset = snap.done ? null : offset;
  snap.atualizado_em = new Date().toISOString();
  await storagePut("reposicao/vendas.json", snap);
  return { ok: true, modo, processados, offset: snap.offset, total_count: snap.total_count, done: snap.done, dias: Object.keys(snap.dias).length };
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  const { run, debug } = req.query;
  try {
    if (run === "estoque") return res.json(await runEstoque());
    if (run === "vendas") return res.json(await runVendas(req.query.pages));
    if (run === "status") {
      const e = await storageGet("reposicao/estoque.json");
      const v = await storageGet("reposicao/vendas.json");
      return res.json({
        estoque: e ? { atualizado_em: e.atualizado_em, total: e.total } : null,
        vendas: v ? { atualizado_em: v.atualizado_em, dias: v.dias ? Object.keys(v.dias).length : 0, done: v.done, total_count: v.total_count, offset: v.offset } : null,
      });
    }
    // ---- teste isolado da gravação no Storage ----
    if (debug === "storage-test") {
      const t0 = Date.now();
      await storagePut("reposicao/test.json", { hello: "world", em: new Date().toISOString() });
      const back = await storageGet("reposicao/test.json");
      return res.json({ ok: true, ms: Date.now() - t0, escrito_e_lido: back, sb_url_set: !!SB_URL(), sb_key_set: !!SB_KEY() });
    }
    // ---- sondagem ----
    if (debug === "bling-prod") { const t = await getBlingToken(); const o = await bling("/produtos?pagina=1&limite=" + (req.query.limite || 3), t); return res.json({ status: o.status, amostra: (o.data && o.data.data) || o.data }); }
    if (debug === "li-prod") { const o = await li("/produto/?limit=" + (req.query.limit || 3)); return res.json({ status: o.status, meta: o.data && o.data.meta, amostra: (o.data && o.data.objects) || o.data }); }
    if (debug === "li-detail") { const o = await li("/produto/" + req.query.id + "/"); return res.json({ status: o.status, amostra: o.data }); }
    if (debug === "li-img") { const o = await li("/produto_imagem/?produto=" + req.query.id); return res.json({ status: o.status, amostra: (o.data && o.data.objects) || o.data }); }
    if (debug === "li-pedidos") { const o = await li("/pedido/?limit=" + (req.query.limit || 2)); return res.json({ status: o.status, meta: o.data && o.data.meta, amostra: (o.data && o.data.objects) || o.data }); }
    return res.json({ ok: true, uso: ["?run=estoque", "?run=vendas&pages=20", "?run=status", "?debug=bling-prod", "?debug=li-prod", "?debug=li-detail&id=", "?debug=li-img&id=", "?debug=li-pedidos"] });
  } catch (err) {
    return res.status(500).json({ erro: err.message });
  }
}
