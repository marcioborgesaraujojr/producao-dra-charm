// Cron da Vercel: roda o ciclo de monitoramento (importa + rastreia + regras).
// Protegido por CMP_CRON_SECRET. A Vercel Cron chama com header Authorization.
import { runCycle } from '../lib/engine.js';
import * as sb from '../lib/supabase.js';

export const config = { maxDuration: 60 };

// ================= Bling Taymah (faturamento) — códigos de rastreio =================
// Token guardado numa linha sentinela em cmp_rules (enabled=false, nunca executa).
const BLING_TOKEN_URL = 'https://www.bling.com.br/Api/v3/oauth/token';
const BLING_API = 'https://www.bling.com.br/Api/v3';
const BLING_KEY = '__bling_taymah__';

async function blingLoad() {
  const r = await sb.selectOne('cmp_rules', { where: `name=eq.${BLING_KEY}` });
  return r ? { id: r.id, ...r.then_json } : null;
}
async function blingSave(data) {
  const ex = await sb.selectOne('cmp_rules', { where: `name=eq.${BLING_KEY}`, columns: 'id' });
  if (ex) await sb.update('cmp_rules', `id=eq.${ex.id}`, { then_json: data });
  else await sb.insert('cmp_rules', { name: BLING_KEY, enabled: false, priority: 99999, when_json: {}, then_json: data }, { returning: false });
}
async function blingTokenPost(cid, secret, params) {
  const r = await fetch(BLING_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json', Authorization: 'Basic ' + Buffer.from(`${cid}:${secret}`).toString('base64') },
    body: new URLSearchParams(params).toString(),
  });
  let j = null; try { j = await r.json(); } catch {}
  return { status: r.status, j };
}
async function blingExchange(code, cid, secret) {
  if (!cid || !secret) { const s = await blingLoad(); cid = cid || s?.cid; secret = secret || s?.secret; }
  if (!cid || !secret) return { ok: false, error: 'credenciais Bling não configuradas' };
  if (!code) return { ok: false, error: 'sem code' };
  const { status, j } = await blingTokenPost(cid, secret, { grant_type: 'authorization_code', code });
  if (!j || !j.access_token) return { ok: false, status, error: (j && (j.error?.description || j.error || JSON.stringify(j))) || 'sem token' };
  await blingSave({ cid, secret, access_token: j.access_token, refresh_token: j.refresh_token, expires_at: Date.now() + (j.expires_in || 21600) * 1000 });
  return { ok: true, hasRefresh: !!j.refresh_token, expires_in: j.expires_in };
}
async function blingToken() {
  const s = await blingLoad();
  if (!s) throw new Error('Bling não conectado');
  if (s.access_token && s.expires_at && Date.now() < s.expires_at - 120000) return s.access_token;
  const { j } = await blingTokenPost(s.cid, s.secret, { grant_type: 'refresh_token', refresh_token: s.refresh_token });
  if (!j || !j.access_token) throw new Error('refresh Bling falhou');
  await blingSave({ cid: s.cid, secret: s.secret, access_token: j.access_token, refresh_token: j.refresh_token || s.refresh_token, expires_at: Date.now() + (j.expires_in || 21600) * 1000 });
  return j.access_token;
}
async function blingGet(path) {
  const tok = await blingToken();
  const r = await fetch(BLING_API + path, { headers: { Authorization: 'Bearer ' + tok, Accept: 'application/json' } });
  let j = null; try { j = await r.json(); } catch {}
  return { status: r.status, j };
}
// Explora NFe/pedido para achar o código de rastreio + transportadora + chave DANFE.
async function blingProbe() {
  const out = {};
  const nf = await blingGet('/nfe?limite=5');
  out.nfe_status = nf.status;
  const list = nf.j?.data || nf.j?.retorno?.nfes || [];
  out.nfe_qtd = list.length;
  if (list[0]) {
    out.nfe_list_campos = Object.keys(list[0]);
    const id = list[0].id;
    const det = await blingGet(`/nfe/${id}`);
    out.nfe_det_status = det.status;
    const d = det.j?.data || det.j || {};
    out.nfe_det_campos = Object.keys(d);
    out.transporte = d.transporte || d.transportador || null;
    out.chave_danfe = d.chaveAcesso || d.chave_acesso || d.chave || null;
  }
  // também tenta pedidos de venda (traz rastreio em alguns casos)
  const pv = await blingGet('/pedidos/vendas?limite=3');
  out.pv_status = pv.status;
  const pvs = pv.j?.data || [];
  if (pvs[0]) { out.pv_campos = Object.keys(pvs[0]); const pd = await blingGet(`/pedidos/vendas/${pvs[0].id}`); out.pv_det_campos = Object.keys(pd.j?.data || {}); out.pv_transporte = (pd.j?.data || {}).transporte || null; }
  return out;
}
// ================================================================================

// Teste READ-ONLY da Loja Integrada (?probe=li) — valida chaves e revela
// os códigos de situação reais da conta. Não escreve nada.
async function liGet(path) {
  const base = process.env.LI_BASE_URL || 'https://api.awsli.com.br/v1';
  const u = new URL(path.startsWith('http') ? path : base + path);
  u.searchParams.set('chave_api', process.env.LI_CHAVE_API || '');
  u.searchParams.set('chave_aplicacao', process.env.LI_CHAVE_APLICACAO || '');
  const r = await fetch(u.toString(), { headers: { Accept: 'application/json' } });
  let j = null; try { j = await r.json(); } catch {}
  return { status: r.status, json: j };
}

// Explora um pedido recente para mapear obs + itens + personalização (bordado).
async function probeOrder(numero) {
  const out = { alvo: numero || 'recentes' };
  // pega pedidos recentes; procura o alvo ou o primeiro com itens
  const lst = await liGet(`/pedido/?limit=10&order_by=-data_criacao`);
  out.list_status = lst.status;
  let objs = lst.json?.objects || [];
  const codOf = (x) => (x.situacao && (x.situacao.codigo || x.situacao)) || '';
  let o = numero ? objs.find((x) => String(x.numero) === String(numero)) : null;
  if (!o) o = objs.find((x) => /enviado/i.test(codOf(x)));
  // se nenhum recente está ENVIADO, busca especificamente enviados (tenta filtros)
  if (!o) {
    for (const f of ['situacao__codigo=pedido_enviado', 'situacao=pedido_enviado']) {
      const en = await liGet(`/pedido/?${f}&limit=3`);
      if (en.status === 200 && (en.json?.objects || []).length) { o = en.json.objects[0]; out.filtro_enviado = f; break; }
    }
  }
  if (!o) o = objs[0];
  if (!o) { out.achou = false; out.list_raw = JSON.stringify(lst.json).slice(0, 200); return out; }
  out.numero = o.numero;
  out.campos = Object.keys(o);
  out.obs = o.observacoes ?? o.obs ?? o.observacao ?? o.mensagem ?? o.observacao_interna ?? null;
  // DETALHE do pedido (via resource_uri) — onde ficam envios/rastreio
  if (o.resource_uri) {
    const det = await liGet(o.resource_uri);
    out.detalhe_status = det.status;
    const d = det.json || {};
    out.detalhe_campos = Object.keys(d);
    const envios = d.envios || d.envio || [];
    out.envios = (Array.isArray(envios) ? envios : [envios]).map((e) => ({
      campos: Object.keys(e || {}),
      objeto: e?.objeto ?? e?.codigo_rastreio ?? e?.rastreio ?? null,
      forma: e?.forma_envio_nome ?? e?.forma_envio ?? e?.nome ?? null,
      url_rastreio: e?.url_rastreamento ?? e?.url ?? null,
    }));
    out.rastreio_top = d.codigo_rastreio ?? d.rastreio ?? null;
  }
  // itens embutidos ou via sub-recurso
  let itens = o.itens || o.items || [];
  out.itens_inline = itens.length;
  if ((!itens.length) && o.id) {
    for (const p of [`/pedido_item/?pedido=${o.id}&limit=50`, `/pedido/${o.id}/itens/`, `/pedido/${o.id}/`]) {
      const it = await liGet(p);
      if (it.status === 200 && it.json) { out.item_endpoint = p; itens = it.json.objects || it.json.itens || []; if (itens.length) break; }
    }
  }
  out.itens = (itens || []).slice(0, 6).map((i) => ({
    campos: Object.keys(i), sku: i.sku, nome: i.nome, qtd: i.quantidade,
    obs: i.observacao ?? i.obs ?? null, person: i.personalizacoes ?? i.personalizacao ?? i.customizacoes ?? null,
  }));
  return out;
}

async function probeLI(numero) {
  if (numero) return probeOrder(numero);
  const base = process.env.LI_BASE_URL || 'https://api.awsli.com.br/v1';
  const u = new URL(base + '/pedido/');
  u.searchParams.set('chave_api', process.env.LI_CHAVE_API || '');
  u.searchParams.set('chave_aplicacao', process.env.LI_CHAVE_APLICACAO || '');
  u.searchParams.set('limit', '20');
  const out = {};
  const r = await fetch(u.toString(), { headers: { Accept: 'application/json' } });
  out.status = r.status;
  let j = null; try { j = await r.json(); } catch {}
  const objs = j?.objects || j?.results || (Array.isArray(j) ? j : []);
  out.total = j?.meta?.total_count ?? null;
  out.amostra = objs.length;
  // códigos de situação reais (para o mapa)
  out.situacoes = [...new Map(objs.map((o) => {
    const s = o.situacao || {}; const cod = s.codigo ?? s.id ?? o.situacao_id;
    return [cod, { codigo: cod, nome: s.nome || s.label || null }];
  })).values()];
  if (objs[0]) {
    const o = objs[0];
    out.campos = Object.keys(o);
    // detectar estrutura de envio/rastreio e itens
    const envio = (o.envios && o.envios[0]) || o.envio || {};
    out.campos_envio = Object.keys(envio);
    const item = (o.itens || o.items || [])[0] || {};
    out.campos_item = Object.keys(item);
    out.exemplo = {
      numero: o.numero, situacao_cod: (o.situacao || {}).codigo, situacao_nome: (o.situacao || {}).nome,
      forma_envio: envio.forma_envio_nome || envio.nome || o.forma_envio_nome,
      objeto: envio.objeto || envio.codigo_rastreio || o.codigo_rastreio || null,
      sku: item.sku || item.produto?.sku || null,
      tem_cliente: !!o.cliente, tem_endereco: !!(o.endereco_entrega || o.enderecoEntrega),
    };
  }
  return out;
}

export default async function handler(req, res) {
  // Rota PÚBLICA: troca OAuth do Bling. O code é single-use e ultracurto,
  // então a página de redirect (rastreio.html) chama isto no ato do retorno.
  if (req.query.bling === 'exchange') {
    try { return res.status(200).json(await blingExchange(req.query.code, req.query.cid, req.query.secret)); }
    catch (e) { return res.status(200).json({ ok: false, error: e.message }); }
  }
  const secret = process.env.CMP_CRON_SECRET;
  const provided = (req.headers.authorization || '').replace('Bearer ', '') || req.query.secret;
  const isVercelCron = !!req.headers['x-vercel-cron'];
  if (secret && !isVercelCron && provided !== secret) {
    return res.status(401).json({ error: 'não autorizado' });
  }
  try {
    if (req.query.probe === 'li') return res.status(200).json(await probeLI(req.query.numero));
    if (req.query.bling === 'setcreds') { await blingSave({ cid: req.query.cid, secret: req.query.secret }); return res.status(200).json({ ok: true }); }
    if (req.query.bling === 'status') { const s = await blingLoad(); return res.status(200).json({ conectado: !!(s && s.access_token), temCreds: !!(s && s.cid), expira: s?.expires_at || null }); }
    if (req.query.bling === 'probe') return res.status(200).json(await blingProbe());
    const result = await runCycle();
    return res.status(200).json({ ok: true, ...result });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
}
