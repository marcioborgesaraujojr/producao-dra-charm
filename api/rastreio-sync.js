// Cron da Vercel: roda o ciclo de monitoramento (importa + rastreia + regras).
// Protegido por CMP_CRON_SECRET. A Vercel Cron chama com header Authorization.
import { runCycle } from '../lib/engine.js';
import * as sb from '../lib/supabase.js';
import { carrierKey } from '../lib/statusmap.js';

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
// ================= J&T VIP (JMS) — rastreio pela sua conta, grátis =================
const JT_BASE = 'https://vipgw.jtjms-br.com';
async function jtLoad() { const r = await sb.selectOne('cmp_rules', { where: 'name=eq.__jt_vip__' }); return r ? r.then_json : null; }
async function jtSave(d) {
  const ex = await sb.selectOne('cmp_rules', { where: 'name=eq.__jt_vip__', columns: 'id' });
  if (ex) await sb.update('cmp_rules', `id=eq.${ex.id}`, { then_json: d });
  else await sb.insert('cmp_rules', { name: '__jt_vip__', enabled: false, priority: 99999, when_json: {}, then_json: d }, { returning: false });
}
async function jtPost(path, body) {
  const s = await jtLoad(); if (!s?.token) throw new Error('J&T VIP sem token');
  const r = await fetch(JT_BASE + path, {
    method: 'POST',
    headers: { Authorization: s.token, routeName: s.routeName || 'waybill', language: 'EN', 'Content-Type': 'application/json', Accept: 'application/json, text/plain, */*' },
    body: JSON.stringify(body),
  });
  let j = null; try { j = await r.json(); } catch {}
  return { status: r.status, j };
}
function ymd(d) { return d.toISOString().slice(0, 10); }
async function jtSync(paginas = 2, dias = 20) {
  const t0 = `${ymd(new Date(Date.now() - dias * 86400000))} 00:00:00`;
  const t1 = `${ymd(new Date())} 23:59:59`;
  const out = { paginas: 0, waybills: 0, atualizados: 0, marcadosEnviado: 0, entregues: 0, semMatch: 0 };
  for (let current = 1; current <= paginas; current++) {
    const { status, j } = await jtPost('/ccm-vip/waybillOrder/page', { current, size: 50, time: [t0, t1], billType: 2, inputTimeStart: t0, inputTimeEnd: t1 });
    if (status !== 200 || j?.code !== 1) { out.erro = `status ${status} code ${j?.code || '?'} (token pode ter expirado)`; break; }
    const list = j.data?.records || j.data?.list || [];
    if (!list.length) break;
    out.paginas++; out.waybills += list.length;
    for (const w of list) {
      const nf = w.invoiceNo; if (!nf) continue;
      const ord = await sb.selectOne('cmp_orders', { where: `nota_fiscal=eq.${encodeURIComponent(String(nf))}` });
      if (!ord) { out.semMatch++; continue; }
      const patch = { transportadora: 'jt' };
      if (w.waybillNo) patch.tracking_code = w.waybillNo;
      patch.raw = { ...(ord.raw || {}), chave_danfe: w.invoiceAccessKey || ord.raw?.chave_danfe, jt_status: w.waybillStatusCode };
      let novo = null;
      if (w.signTime) novo = 'entregue'; else if (w.collectTime) novo = 'enviado';
      if (novo && ord.status !== novo && !['cancelado', 'devolvido'].includes(ord.status)) {
        patch.status = novo;
        if (novo === 'enviado' && !ord.data_envio) patch.data_envio = w.collectTime;
        if (novo === 'enviado') out.marcadosEnviado++;
        if (novo === 'entregue') { if (!ord.data_entrega) patch.data_entrega = w.signTime; if (ord.acareacao_aberta) patch.acareacao_aberta = false; out.entregues++; }
      }
      await sb.update('cmp_orders', `id=eq.${ord.id}`, patch);
      out.atualizados++;
    }
    if (list.length < 50) break;
  }
  return out;
}
// ==================================================================================
// ================= Melhor Envio (rastreio grátis do que passa por lá) =================
const ME_BASE = 'https://melhorenvio.com.br/api/v2';
async function meLoad() { const r = await sb.selectOne('cmp_rules', { where: 'name=eq.__melhorenvio__' }); return r ? r.then_json : null; }
async function meSave(d) {
  const ex = await sb.selectOne('cmp_rules', { where: 'name=eq.__melhorenvio__', columns: 'id' });
  if (ex) await sb.update('cmp_rules', `id=eq.${ex.id}`, { then_json: d });
  else await sb.insert('cmp_rules', { name: '__melhorenvio__', enabled: false, priority: 99999, when_json: {}, then_json: d }, { returning: false });
}
async function meGet(path) {
  const s = await meLoad(); if (!s?.token) throw new Error('Melhor Envio sem token');
  const r = await fetch(ME_BASE + path, { headers: { Authorization: 'Bearer ' + s.token, Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': 'Rastreio Aragao (contato@dracharm.com.br)' } });
  let j = null; try { j = await r.json(); } catch {}
  return { status: r.status, j };
}
async function meProbe() {
  const out = {};
  const me = await meGet('/me');
  out.me_status = me.status;
  out.conta = me.j ? { id: me.j.id, nome: me.j.firstname || me.j.name, email: me.j.email } : null;
  // lista pedidos/envios recentes
  const ord = await meGet('/me/orders?limit=10');
  out.orders_status = ord.status;
  const list = ord.j?.data || ord.j || [];
  out.orders_qtd = Array.isArray(list) ? list.length : 0;
  if (Array.isArray(list) && list[0]) {
    out.order_campos = Object.keys(list[0]);
    out.amostra = list.slice(0, 8).map((o) => ({
      protocol: o.protocol, status: o.status,
      transportadora: o.service?.company?.name || o.company?.name || o.service?.name,
      rastreio: o.tracking || o.self_tracking || null,
      nf: o.invoice?.number || null,
    }));
  }
  return out;
}
// ==================================================================================
// SYNC do Bling Taymah: puxa NFs recentes, extrai código de rastreio +
// transportadora + chave DANFE, casa com nosso pedido (numeroPedidoLoja) e
// marca Enviado. NÃO escreve status na LI (parallel run — evita WhatsApp duplo).
async function blingSync(limite = 50) {
  const nf = await blingGet(`/nfe?limite=${limite}`);
  const list = nf.j?.data || [];
  const out = { nfes: list.length, atualizados: 0, comCodigo: 0, semMatch: 0, marcadosEnviado: 0, amostra: [] };
  for (const n of list) {
    let d;
    try { const det = await blingGet(`/nfe/${n.id}`); d = det.j?.data || {}; } catch { continue; }
    const numeroLoja = d.numeroPedidoLoja || n.numeroPedidoLoja;
    if (!numeroLoja) continue;
    const tr = d.transporte || {};
    const vol = (tr.volumes || [])[0] || {};
    const codigo = vol.codigoRastreamento || null;
    const servico = vol.servico || tr.transportador?.nome || '';
    const chave = d.chaveAcesso || null;
    const cpf = (d.contato && (d.contato.numeroDocumento || d.contato.cpfCnpj)) || null;
    const ordr = await sb.selectOne('cmp_orders', { where: `numero=eq.${encodeURIComponent(String(numeroLoja))}` });
    if (!ordr) { out.semMatch++; continue; }
    const patch = {};
    if (d.numero && !ordr.nota_fiscal) patch.nota_fiscal = String(d.numero);
    if (codigo) { patch.tracking_code = codigo; out.comCodigo++; }
    if (servico) { patch.transportadora = carrierKey(servico); patch.servico = servico; }
    patch.raw = { ...(ordr.raw || {}), chave_danfe: chave, cpf_cliente: cpf, bling_nfe_id: n.id };
    const naoFinal = !['enviado', 'entregue', 'atrasado', 'devolvido', 'cancelado'].includes(ordr.status);
    if (codigo && naoFinal) { patch.status = 'enviado'; if (!ordr.data_envio) patch.data_envio = new Date().toISOString(); out.marcadosEnviado++; }
    await sb.update('cmp_orders', `id=eq.${ordr.id}`, patch);
    out.atualizados++;
    if (out.amostra.length < 6) out.amostra.push({ pedido: numeroLoja, transportadora: patch.transportadora, temCodigo: !!codigo });
  }
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
  // Salvar/atualizar token do J&T VIP (público+CORS, guardado pelo secret no corpo —
  // permite colar o token direto do painel do J&T sem sair de lá).
  if (req.query.jt === 'save') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    if (req.method === 'OPTIONS') return res.status(200).end();
    const b = req.body || {};
    if (b.secret !== process.env.CMP_CRON_SECRET) return res.status(401).json({ error: 'não autorizado' });
    if (!b.token) return res.status(400).json({ error: 'sem token' });
    await jtSave({ token: b.token, routeName: b.routeName || 'waybill', saved_at: new Date().toISOString() });
    return res.status(200).json({ ok: true });
  }
  const secret = process.env.CMP_CRON_SECRET;
  const provided = (req.headers.authorization || '').replace('Bearer ', '') || req.query.secret;
  const isVercelCron = !!req.headers['x-vercel-cron'];
  if (secret && !isVercelCron && provided !== secret) {
    return res.status(401).json({ error: 'não autorizado' });
  }
  try {
    if (req.query.probe === 'li') return res.status(200).json(await probeLI(req.query.numero));
    if (req.query.cws === 'test') {
      const u = req.query.u || process.env.CORREIOS_CWS_USUARIO, s = req.query.s || process.env.CORREIOS_CWS_SENHA, c = req.query.c || process.env.CORREIOS_CARTAO_POSTAGEM;
      const rr = await fetch('https://api.correios.com.br/token/v1/autentica/cartaopostagem', { method: 'POST', headers: { Authorization: 'Basic ' + Buffer.from(`${u}:${s}`).toString('base64'), 'Content-Type': 'application/json' }, body: JSON.stringify({ numero: c }) });
      const tt = await rr.text(); let jj = null; try { jj = JSON.parse(tt); } catch {}
      return res.status(200).json({ status: rr.status, autenticou: !!(jj && jj.token), expira: jj?.expiraEm || null, ambiente: jj?.ambiente || null, erro: (jj && !jj.token) ? (jj.mensagem || tt.slice(0, 160)) : null });
    }
    if (req.query.bling === 'setcreds') { await blingSave({ cid: req.query.cid, secret: req.query.secret }); return res.status(200).json({ ok: true }); }
    if (req.query.bling === 'status') { const s = await blingLoad(); return res.status(200).json({ conectado: !!(s && s.access_token), temCreds: !!(s && s.cid), expira: s?.expires_at || null }); }
    if (req.query.bling === 'probe') return res.status(200).json(await blingProbe());
    if (req.query.bling === 'sync') return res.status(200).json(await blingSync(Number(req.query.limite) || 50));
    if (req.query.me === 'save') { await meSave({ token: req.query.token || req.body?.token }); return res.status(200).json({ ok: true }); }
    if (req.query.me === 'probe') return res.status(200).json(await meProbe());
    if (req.query.jt === 'status') { const s = await jtLoad(); return res.status(200).json({ temToken: !!s?.token, salvo_em: s?.saved_at || null }); }
    if (req.query.jt === 'sync') return res.status(200).json(await jtSync(Number(req.query.paginas) || 2));
    const result = await runCycle();
    return res.status(200).json({ ok: true, ...result });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
}
