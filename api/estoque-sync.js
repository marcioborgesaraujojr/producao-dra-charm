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
// IMPORTANTE: o Bling ROTACIONA o refresh token a cada refresh. Se não salvarmos o novo,
// o próximo refresh (aqui ou em qualquer outra função) falha. Por isso salvamos de volta.
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
      if (i < 2) await new Promise((res) => setTimeout(res, 200));
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
  if (d.refresh_token && d.refresh_token !== refreshToken) await salvarRefreshToken(d.refresh_token);
  await salvarAccessTokenCache(d.access_token);
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

// Extrai a URL da foto do array "imagens" do produto LI (variação NÃO tem foto; vem do pai).
// Mesma lógica do api/personalizacao-sync.js.
function pickImg(pj) {
  const imgs = (pj && (pj.imagens || pj.imagem)) || [];
  const f = (Array.isArray(imgs) ? imgs[0] : imgs) || null;
  if (!f) return null;
  if (typeof f === "string") return f;
  return f.grande || f.media || f["380x380"] || f.pequena || f.thumbnail || f["64x64"] || f.url || f.imagem || f.src || f.caminho || null;
}
// Coleta SKUs ATIVOS da LI + mapa de id do pai (foto) + status ativo do PAI por SKU.
// (Ao desativar na LI, o pai fica inativo mas as variações continuam "ativas" — por isso
//  precisamos checar o pai pra não mostrar produto desativado.)
async function coletarLI() {
  const skus = new Set();
  const parentIdBySku = {};
  const paiAtivoByCodigo = {}; // sku(pai, lower) -> boolean (todos os pais, ativos ou não)
  let offset = 0;
  const LIMIT = 100, MAXP = 80;
  for (let i = 0; i < MAXP; i++) {
    const out = await li("/produto/?limit=" + LIMIT + "&offset=" + offset);
    if (!out.ok || !out.data) break;
    const objs = out.data.objects || [];
    if (!objs.length) break;
    for (const p of objs) {
      if (!p.sku) continue;
      const s = String(p.sku).toLowerCase().trim();
      const ativoDeVerdade = !!(p.ativo && !p.removido && !p.bloqueado);
      if (p.tipo !== "atributo_opcao") { // pai/standalone
        paiAtivoByCodigo[s] = ativoDeVerdade;
        if (ativoDeVerdade) parentIdBySku[s] = p.id;
      }
      if (ativoDeVerdade) skus.add(s);
    }
    if (objs.length < LIMIT) break;
    offset += objs.length;
  }
  return { skus, parentIdBySku, paiAtivoByCodigo };
}
// Ordem canônica dos tamanhos
const ORDEM_TAM = ["PP", "P", "M", "G", "GG", "XG", "XGG", "EG", "EGG", "U", "UNICO", "ÚNICO"];
function ordemTam(t) { const i = ORDEM_TAM.indexOf((t || "").toUpperCase()); return i < 0 ? 99 : i; }
function tamanhoDe(p) {
  const m = (p.nome || "").match(/TAMANHO\s*:?\s*([A-Za-zÀ-ú0-9]+)/i);
  if (m) return m[1].toUpperCase();
  const parts = String(p.sku || "").split("-");
  const suf = parts.length > 1 ? parts[parts.length - 1] : "";
  return (suf || "U").toUpperCase();
}
function limpaNome(n) {
  return (n || "").replace(/\s*-?\s*TAMANHO\s*:?.*$/i, "").replace(/\s*:\s*(PP|P|M|G|GG|XG|XGG|U|UNICO|ÚNICO)\s*$/i, "").trim();
}
// Itens de serviço/acréscimo que NÃO são produto (não entram na lista de estoque).
function isServico(nome) {
  return /acr[eé]scimo|embalagem|personaliza|brinde|vale.?presente|cart[aã]o|frete|desconto/i.test(String(nome || ""));
}
// ============ SYNC ESTOQUE (Bling, filtrado pela LI, AGRUPADO por produto pai) ============
async function runEstoque() {
  const { skus: liSkus, parentIdBySku, paiAtivoByCodigo } = await coletarLI(); // ativos + foto + status do pai
  const token = await getBlingToken();
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const flat = [];
  const blingCodigoById = {}; // id -> codigo de TODOS os produtos (mesmo inativos), pra achar o SKU do pai
  let pagina = 1, ignorados = 0;
  const LIMITE = 100, MAX_PAGINAS = 60;
  while (pagina <= MAX_PAGINAS) {
    // Retry: se vier vazio por soluço/rate-limit do Bling, tenta de novo antes de desistir.
    let lista = [], tent = 0, ok = false;
    while (tent < 3) {
      const out = await bling("/produtos?pagina=" + pagina + "&limite=" + LIMITE + "&criterio=2", token);
      lista = (out.data && out.data.data) || [];
      if (lista.length) { ok = true; break; }
      tent++; await sleep(700);
    }
    if (!ok || !lista.length) break; // fim de verdade
    for (const p of lista) {
      const sku = p.codigo || String(p.id);
      blingCodigoById[String(p.id)] = sku; // guarda o codigo de todo produto (pra achar o pai depois)
      if (liSkus.size && !liSkus.has(String(sku).toLowerCase().trim())) { ignorados++; continue; }
      if (isServico(p.nome)) { ignorados++; continue; } // pula acréscimo/embalagem/personalização/etc.
      flat.push({
        id: p.id, sku, nome: p.nome || "", pai: p.idProdutoPai || null,
        preco: Number(p.preco || 0), custo: Number(p.precoCusto || 0),
        saldo: Number((p.estoque && (p.estoque.saldoVirtualTotal ?? p.estoque.saldoFisicoTotal)) || 0),
        ativo: (p.situacao || "A") === "A",
      });
    }
    if (lista.length < LIMITE) break;
    pagina++;
    await sleep(250); // respeita o rate limit do Bling (3 req/s)
  }
  // Guarda o SKU do produto pai do Bling (bate com o SKU do pai na LI -> foto)
  const temFilhos = new Set(flat.filter(p => p.pai).map(p => String(p.pai)));
  const grupos = {};
  for (const p of flat) {
    if (!p.pai && temFilhos.has(String(p.id))) continue; // é o pai -> ignora como card
    const key = p.pai ? "p" + p.pai : "s" + p.id;
    let g = grupos[key];
    if (!g) { g = grupos[key] = { nome: limpaNome(p.nome) || p.nome, preco: p.preco, custo: p.custo, imagem: null, sku_base: (p.sku || "").split("-")[0], pai_codigo: p.pai ? (blingCodigoById[String(p.pai)] || null) : p.sku, tamanhos: [] }; }
    if (!g.nome) g.nome = limpaNome(p.nome) || p.nome;
    if (!g.preco && p.preco) g.preco = p.preco;
    g.tamanhos.push({ tamanho: tamanhoDe(p), sku: p.sku, saldo: p.saldo, ativo: p.ativo });
  }
  const produtos = Object.values(grupos).map(g => {
    g.tamanhos.sort((a, b) => ordemTam(a.tamanho) - ordemTam(b.tamanho) || a.tamanho.localeCompare(b.tamanho));
    const saldo_total = g.tamanhos.reduce((s, t) => s + (t.saldo || 0), 0);
    const grades_zeradas = g.tamanhos.filter(t => (t.saldo || 0) <= 0).length;
    return { nome: g.nome, sku_base: g.sku_base, pai_codigo: g.pai_codigo, preco: g.preco, custo: g.custo, imagem: null, saldo_total, grades: g.tamanhos.length, grades_zeradas, tamanhos: g.tamanhos };
  })
  // Remove produtos cujo PAI está inativo na LI (a variação continua "ativa", mas o pai não).
  .filter(p => paiAtivoByCodigo[String(p.pai_codigo || "").toLowerCase()] !== false);
  // Snapshot anterior (pra merge de fotos e pra trava anti-sobrescrita)
  let prev = null;
  try { prev = await storageGet("reposicao/estoque.json"); } catch (_) {}
  // TRAVA: dispara só quando a VARREDURA veio parcial (poucas variações = soluço do Bling),
  // não quando é só filtro removendo produtos. Assim não sobrescreve o catálogo bom.
  if (prev && prev.total_variacoes && flat.length < prev.total_variacoes * 0.5) {
    return { ok: false, motivo: "varredura parcial (Bling) — mantido o snapshot anterior", variacoes_agora: flat.length, variacoes_antes: prev.total_variacoes, paginas: pagina };
  }
  // Reaproveita fotos já buscadas
  if (prev && prev.produtos) {
    const imgPrev = {};
    prev.produtos.forEach(p => { if (p.imagem && p.pai_codigo) imgPrev[String(p.pai_codigo).toLowerCase()] = p.imagem; });
    produtos.forEach(p => { const k = String(p.pai_codigo || "").toLowerCase(); if (!p.imagem && imgPrev[k]) p.imagem = imgPrev[k]; });
  }
  // Busca as fotos faltantes na LI (produto pai -> imagens[0]), com orçamento de tempo pra não estourar.
  const t0img = Date.now();
  let buscadas = 0;
  for (const p of produtos) {
    if (p.imagem) continue;
    if (Date.now() - t0img > 28000) break;
    const pid = parentIdBySku[String(p.pai_codigo || "").toLowerCase()];
    if (!pid) continue;
    try { const d = await li("/produto/" + pid + "/"); const url = pickImg(d.data); if (url) { p.imagem = url; buscadas++; } } catch (_) {}
  }
  const com_imagem = produtos.filter(p => p.imagem).length;
  const snap = { atualizado_em: new Date().toISOString(), li_skus: liSkus.size, total_produtos: produtos.length, total_variacoes: flat.length, ignorados, com_imagem, produtos };
  await storagePut("reposicao/estoque.json", snap);
  return { ok: true, total_produtos: produtos.length, total_variacoes: flat.length, li_skus: liSkus.size, ignorados, com_imagem, imagens_buscadas: buscadas, paginas: pagina };
}

// ============ SYNC VENDAS (LI, cabeçalhos) — backfill + diário ============
function diaISO(dt) { return (dt || "").slice(0, 10); }
// Data de hoje no fuso de Brasília (a LI devolve data_criacao em BRT, então os "dias" são BRT).
function hojeBR() { return new Date().toLocaleDateString("en-CA", { timeZone: "America/Sao_Paulo" }); }
function diasAtras(n) { const d = new Date(hojeBR() + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() - n); return d.toISOString().slice(0, 10); }
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
// Extrai o ID do cliente da URI ("/api/v1/cliente/36583578" -> "36583578"). Só o ID (sem nome/email).
function cidFromURI(u) { const m = String(u || "").match(/cliente\/(\d+)/); return m ? m[1] : null; }
// Livro-razão de pedidos PAGOS, idempotente por id do pedido: pagos[id] = { c: clienteId, r: valor, d: dia }.
// Reprocessar o mesmo pedido só reescreve a mesma chave (sem duplicar). Se deixou de ser pago, remove.
function regPago(pagos, p) {
  const dia = diaISO(p.data_criacao); if (!dia) return;
  const sit = p.situacao || {};
  const pago = !!sit.aprovado && !sit.cancelado;
  const id = String(p.id);
  if (pago) pagos[id] = { c: cidFromURI(p.cliente), r: Number(p.valor_total || 0), d: dia };
  else if (pagos[id]) delete pagos[id];
}
async function lerPagos(reset, janela) {
  const pg = (reset ? null : await storageGet("reposicao/pagos.json")) || { atualizado_em: null, janela_dias: janela || 1095, pagos: {} };
  if (!pg.pagos) pg.pagos = {};
  return pg;
}
async function salvarPagos(pg, corte) {
  if (corte) { for (const k of Object.keys(pg.pagos)) if (pg.pagos[k].d < corte) delete pg.pagos[k]; } // poda além da janela
  pg.total = Object.keys(pg.pagos).length;
  pg.atualizado_em = new Date().toISOString();
  await storagePut("reposicao/pagos.json", pg);
}
// Períodos padrão (mesmas chaves do <select> do front). Datas no fuso de Brasília (igual ao front).
function periodosPadrao() {
  const hj = hojeBR();
  const y = parseInt(hj.slice(0, 4));
  const d = (n) => diasAtras(n);
  return {
    hoje: [hj, hj], ontem: [d(1), d(1)],
    "7": [d(6), hj], mes: [hj.slice(0, 7) + "-01", hj], "30": [d(29), hj],
    ano_atual: [y + "-01-01", hj], ano_passado: [(y - 1) + "-01-01", (y - 1) + "-12-31"],
    "90": [d(89), hj], "365": [d(364), hj], "730": [d(729), hj], "1095": [d(1094), hj],
  };
}
// Pré-calcula os indicadores de cliente pra cada período padrão (o livro-razão fica só no servidor;
// o front recebe só este JSON pequeno). novosPorDia serve pra períodos personalizados (novos/crescimento).
function computeKpis(pagos) {
  const firstByC = {};
  for (const k in pagos) { const e = pagos[k]; const c = e.c; if (!c) continue; if (!firstByC[c] || e.d < firstByC[c]) firstByC[c] = e.d; }
  const novosPorDia = {};
  for (const c in firstByC) { const dd = firstByC[c]; novosPorDia[dd] = (novosPorDia[dd] || 0) + 1; }
  const pers = periodosPadrao();
  const out = {};
  for (const key in pers) {
    const de = pers[key][0], ate = pers[key][1];
    const byC = {}; let receita = 0, ped = 0;
    for (const k in pagos) { const e = pagos[k]; if (e.d < de || e.d > ate) continue; ped++; receita += (e.r || 0); const c = e.c; if (!c) continue; byC[c] = (byC[c] || 0) + 1; }
    let ativos = 0, recor = 0; for (const c in byC) { ativos++; if (byC[c] >= 2) recor++; }
    let novos = 0, base = 0; for (const c in firstByC) { const f = firstByC[c]; if (f >= de && f <= ate) novos++; else if (f < de) base++; }
    out[key] = { ativos, recorrentes: recor, novos, base_antes: base, receita: Math.round(receita * 100) / 100, pedidos: ped };
  }
  return { atualizado_em: new Date().toISOString(), periods: out, novosPorDia };
}
async function salvarKpis(pagos) {
  try { await storagePut("reposicao/kpis.json", computeKpis(pagos)); } catch (_) {}
}
async function runVendas(maxPages, reset, rewind) {
  maxPages = Math.min(Math.max(parseInt(maxPages) || 20, 1), 60);
  let snap = (reset ? null : await storageGet("reposicao/vendas.json")) || { atualizado_em: null, offset: 0, total_count: 0, dias: {}, done: false, janela_dias: 1095 };
  if (!snap.dias) snap.dias = {};
  // rewind: volta a varrer do pedido mais novo SEM apagar dias/pagos (só re-registra, idempotente).
  // Serve pra preencher o livro-razão de pagos numa faixa que já foi varrida antes de existir o pagos.json.
  if (rewind) { snap.offset = 0; snap.done = false; }
  const LIMIT = 100;
  const corte = diasAtras(snap.janela_dias || 365); // 'YYYY-MM-DD'
  const modo = snap.done ? "incremental" : "backfill";
  const pg = await lerPagos(reset, snap.janela_dias || 1095); // livro-razão de pagos por cliente
  // Mais NOVO primeiro (order_by=-data_criacao): offset 0 = pedidos mais recentes.
  let offset = (modo === "backfill") ? (snap.offset || 0) : 0;
  // Incremental: apaga os últimos N dias e RECONTA eles do zero. O re-scan tem que cobrir toda essa janela,
  // senão apaga dias que não volta a preencher (era o bug: apagava 3 dias mas só varria ~1,3 dia de pedidos,
  // então os dias 2-3 atrás sumiam). Agora varre até passar de 'inc' (achar pedido mais antigo que a janela).
  const inc = (modo === "incremental") ? diasAtras(3) : null;
  if (modo === "incremental") { for (const k of Object.keys(snap.dias)) if (k >= inc) delete snap.dias[k]; for (const k of Object.keys(pg.pagos)) if (pg.pagos[k].d >= inc) delete pg.pagos[k]; }
  let processados = 0, ultOk = false;
  for (let i = 0; i < maxPages; i++) {
    const out = await li("/pedido/?limit=" + LIMIT + "&offset=" + offset + "&order_by=-data_criacao");
    if (!out.ok || !out.data) break;
    ultOk = true;
    if (out.data.meta && out.data.meta.total_count) snap.total_count = out.data.meta.total_count;
    const objs = out.data.objects || [];
    if (!objs.length) { snap.done = true; break; }
    let passouDoCorte = false, passouInc = false;
    for (const p of objs) {
      const dia = diaISO(p.data_criacao);
      if (dia && dia >= corte) { if (!rewind) agregaPedido(snap.dias, p); regPago(pg.pagos, p); processados++; }
      else if (dia) { passouDoCorte = true; }
      if (dia && inc && dia < inc) passouInc = true; // já chegou num pedido anterior à janela apagada
    }
    offset += objs.length;
    if (objs.length < LIMIT) { snap.done = true; break; }
    if (passouDoCorte && modo === "backfill") { snap.done = true; break; } // já entrou em pedidos com +1 ano
    if (modo === "incremental" && passouInc) break; // cobriu TODOS os dias apagados (não para antes)
  }
  if (modo === "backfill") snap.offset = snap.done ? 0 : offset;
  snap.atualizado_em = new Date().toISOString();
  await storagePut("reposicao/vendas.json", snap);
  await salvarPagos(pg, corte);
  await salvarKpis(pg.pagos);
  return { ok: true, modo, processados, offset: snap.offset, total_count: snap.total_count, done: snap.done, dias: Object.keys(snap.dias).length, pagos: pg.total, li_ok: ultOk };
}

// Atualiza SÓ os últimos dias (inclui hoje) sem mexer no backfill — pra o "Hoje" vir na hora.
async function runVendasRecente() {
  let snap = (await storageGet("reposicao/vendas.json")) || { atualizado_em: null, offset: 0, total_count: 0, dias: {}, done: false, janela_dias: 1095 };
  if (!snap.dias) snap.dias = {};
  const LIMIT = 100;
  const inc = diasAtras(4); // últimos ~3-4 dias
  for (const k of Object.keys(snap.dias)) if (k >= inc) delete snap.dias[k]; // recontar do zero esses dias
  const pg = await lerPagos(false, snap.janela_dias || 1095);
  for (const k of Object.keys(pg.pagos)) if (pg.pagos[k].d >= inc) delete pg.pagos[k]; // idem no livro-razão
  let offset = 0, processados = 0;
  // Teto de 20 páginas (~2000 pedidos): apaga 4 dias, então o re-scan precisa cobrir >=4 dias de pedidos
  // (com ~250/dia, 8 páginas não bastavam e o dia mais antigo da janela sumia). Para ao passar de 'inc'.
  for (let i = 0; i < 20; i++) {
    const out = await li("/pedido/?limit=" + LIMIT + "&offset=" + offset + "&order_by=-data_criacao");
    if (!out.ok || !out.data) break;
    if (out.data.meta && out.data.meta.total_count) snap.total_count = out.data.meta.total_count;
    const objs = out.data.objects || [];
    if (!objs.length) break;
    let passou = false;
    for (const p of objs) { const dia = diaISO(p.data_criacao); if (dia && dia >= inc) { agregaPedido(snap.dias, p); regPago(pg.pagos, p); processados++; } else if (dia) { passou = true; } }
    offset += objs.length;
    if (passou || objs.length < LIMIT) break;
  }
  snap.atualizado_em = new Date().toISOString();
  await storagePut("reposicao/vendas.json", snap);
  await salvarPagos(pg, null);
  await salvarKpis(pg.pagos);
  return { ok: true, processados, dias: Object.keys(snap.dias).length, pagos: pg.total };
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  const { run, debug } = req.query;
  try {
    if (run === "estoque") return res.json(await runEstoque());
    if (run === "vendas") return res.json(await runVendas(req.query.pages, req.query.reset === "1", req.query.rewind === "1"));
    if (run === "vendas-recente") return res.json(await runVendasRecente());
    // AUDITORIA (só leitura, não grava): re-lê os últimos N dias DIRETO da LI e compara com o gravado.
    if (run === "audit") {
      const nDias = Math.min(Math.max(parseInt(req.query.dias || "14", 10), 1), 60);
      const inc = diasAtras(nDias);
      const fresh = {}; let offset = 0, pages = 0, liOk = false;
      for (let i = 0; i < 40; i++) {
        const out = await li("/pedido/?limit=100&offset=" + offset + "&order_by=-data_criacao");
        if (!out.ok || !out.data) break;
        liOk = true;
        const objs = out.data.objects || [];
        if (!objs.length) break;
        pages++;
        let passou = false;
        for (const p of objs) {
          const dia = diaISO(p.data_criacao);
          if (dia && dia >= inc) {
            const sit = p.situacao || {}; const pago = !!sit.aprovado && !sit.cancelado;
            const d = fresh[dia] || (fresh[dia] = { pedidos: 0, pagos: 0, receita: 0, receita_paga: 0 });
            d.pedidos++; d.receita += Number(p.valor_total || 0);
            if (pago) { d.pagos++; d.receita_paga += Number(p.valor_total || 0); }
          } else if (dia) passou = true;
        }
        offset += objs.length;
        if (passou || objs.length < 100) break;
      }
      const snap = (await storageGet("reposicao/vendas.json")) || { dias: {} };
      const comparacao = Object.keys(fresh).sort().map((dia) => {
        const s = snap.dias[dia] || {}; const li = fresh[dia];
        const okPed = (s.pedidos || 0) === li.pedidos;
        const okPago = Math.abs((s.receita_paga || 0) - li.receita_paga) < 1;
        return { dia, li_ped: li.pedidos, arm_ped: s.pedidos || 0, li_pago: Math.round(li.receita_paga * 100) / 100, arm_pago: Math.round((s.receita_paga || 0) * 100) / 100, bate: okPed && okPago };
      });
      const ks = Object.keys(snap.dias || {}).sort();
      return res.json({ ok: true, li_ok: liOk, pages, dias_auditados: nDias, todos_batem: comparacao.every((c) => c.bate), comparacao, cobertura: { primeiro: ks[0], ultimo: ks[ks.length - 1], dias: ks.length, janela_dias: snap.janela_dias, total_count_LI: snap.total_count } });
    }
    if (run === "kpis") { const pg = await storageGet("reposicao/pagos.json"); if (!pg || !pg.pagos) return res.json({ ok: false, motivo: "pagos.json ainda não existe" }); const k = computeKpis(pg.pagos); await storagePut("reposicao/kpis.json", k); return res.json({ ok: true, pagos: Object.keys(pg.pagos).length, periods: Object.keys(k.periods).length }); }
    if (run === "status") {
      const e = await storageGet("reposicao/estoque.json");
      const v = await storageGet("reposicao/vendas.json");
      const pg = await storageGet("reposicao/pagos.json");
      return res.json({
        estoque: e ? { atualizado_em: e.atualizado_em, total: e.total } : null,
        vendas: v ? { atualizado_em: v.atualizado_em, dias: v.dias ? Object.keys(v.dias).length : 0, done: v.done, total_count: v.total_count, offset: v.offset } : null,
        pagos: pg ? { atualizado_em: pg.atualizado_em, total: pg.total || (pg.pagos ? Object.keys(pg.pagos).length : 0) } : null,
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
    if (debug === "li-sku") {
      const out = await li("/produto/?sku=" + encodeURIComponent(req.query.sku || ""));
      const objs = (out.data && out.data.objects) || [];
      return res.json({ status: out.status, matches: objs.map(p => ({ sku: p.sku, tipo: p.tipo, ativo: p.ativo, removido: p.removido, bloqueado: p.bloqueado, id: p.id, nome: (p.nome || "").slice(0, 60) })) });
    }
    if (debug === "li-detail") { const o = await li("/produto/" + req.query.id + "/"); return res.json({ status: o.status, amostra: o.data }); }
    if (debug === "li-img") { const o = await li("/produto_imagem/?produto=" + req.query.id); return res.json({ status: o.status, amostra: (o.data && o.data.objects) || o.data }); }
    if (debug === "li-pedidos") { const o = await li("/pedido/?limit=" + (req.query.limit || 2)); return res.json({ status: o.status, meta: o.data && o.data.meta, amostra: (o.data && o.data.objects) || o.data }); }
    return res.json({ ok: true, uso: ["?run=estoque", "?run=vendas&pages=20", "?run=status", "?debug=bling-prod", "?debug=li-prod", "?debug=li-detail&id=", "?debug=li-img&id=", "?debug=li-pedidos"] });
  } catch (err) {
    return res.status(500).json({ erro: err.message });
  }
}
