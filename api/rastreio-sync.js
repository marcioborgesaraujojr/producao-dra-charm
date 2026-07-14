// Cron da Vercel: roda o ciclo de monitoramento (importa + rastreia + regras).
// Protegido por CMP_CRON_SECRET. A Vercel Cron chama com header Authorization.
import { runCycle, processOrder } from '../lib/engine.js';
import * as sb from '../lib/supabase.js';
import * as li from '../lib/li.js';
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
// Gera variações do número da NF (com/sem zeros à esquerda) para casar com o nosso banco.
function nfCandidates(nf) {
  const digits = String(nf == null ? '' : nf).replace(/\D/g, '');
  if (!digits) return [];
  const noZeros = String(Number(digits));
  return [...new Set([String(nf), digits, noZeros, noZeros.padStart(6, '0'), noZeros.padStart(9, '0')])].filter(Boolean);
}
async function findOrderByChave(chave) {
  if (!chave) return null;
  return sb.selectOne('cmp_orders', { where: `raw->>chave_danfe=eq.${encodeURIComponent(chave)}` });
}
async function findOrderByNF(nf) {
  const cands = nfCandidates(nf).filter((c) => /^\d+$/.test(c));
  if (!cands.length) return null;
  return sb.selectOne('cmp_orders', { where: `nota_fiscal=in.(${cands.join(',')})` });
}
// Casa o waybill do J&T com o nosso pedido: 1º pela chave DANFE (única), depois pela NF.
async function matchWaybill(w) {
  let ord = await findOrderByChave(w.invoiceAccessKey);
  if (ord) return { ord, via: 'chave' };
  ord = await findOrderByNF(w.invoiceNo);
  if (ord) return { ord, via: 'nf' };
  return { ord: null, via: null };
}
async function jtSync(paginas = 3, dias = 30) {
  const s = await jtLoad();
  if (!s?.token) return { erro: 'J&T VIP sem token — refazer login no painel VIP' };
  const t0 = `${ymd(new Date(Date.now() - dias * 86400000))} 00:00:00`;
  const t1 = `${ymd(new Date())} 23:59:59`;
  const out = { paginas: 0, waybills: 0, atualizados: 0, viaChave: 0, viaNF: 0, marcadosEnviado: 0, entregues: 0, semMatch: 0 };
  for (let current = 1; current <= paginas; current++) {
    const { status, j } = await jtPost('/ccm-vip/waybillOrder/page', { current, size: 50, time: [t0, t1], billType: 2, inputTimeStart: t0, inputTimeEnd: t1 });
    if (status !== 200 || j?.code !== 1) { out.erro = `status ${status} code ${j?.code || '?'} (token do J&T pode ter expirado)`; break; }
    const list = j.data?.records || j.data?.list || [];
    if (!list.length) break;
    out.paginas++; out.waybills += list.length;
    for (const w of list) {
      const { ord, via } = await matchWaybill(w);
      if (!ord) { out.semMatch++; continue; }
      if (via === 'chave') out.viaChave++; else out.viaNF++;
      const patch = { transportadora: 'jt' };
      if (w.waybillNo) patch.tracking_code = w.waybillNo;
      if (w.invoiceNo && !ord.nota_fiscal) patch.nota_fiscal = String(w.invoiceNo);
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
// Diagnóstico do casamento J&T: mostra os valores reais e se casam.
async function jtDiag(dias = 30) {
  const t0 = `${ymd(new Date(Date.now() - dias * 86400000))} 00:00:00`;
  const t1 = `${ymd(new Date())} 23:59:59`;
  const { status, j } = await jtPost('/ccm-vip/waybillOrder/page', { current: 1, size: 10, time: [t0, t1], billType: 2, inputTimeStart: t0, inputTimeEnd: t1 });
  if (status !== 200 || j?.code !== 1) return { erro: `status ${status} code ${j?.code}` };
  const list = j.data?.records || j.data?.list || [];
  const rows = [];
  for (const w of list) {
    const byChave = await findOrderByChave(w.invoiceAccessKey);
    const byNF = await findOrderByNF(w.invoiceNo);
    rows.push({ waybillNo: w.waybillNo, invoiceNo: w.invoiceNo, chaveFim: (w.invoiceAccessKey || '').slice(-8), nfCands: nfCandidates(w.invoiceNo), casouChave: byChave?.numero || null, casouNF: byNF?.numero || null, entregue: !!w.signTime });
  }
  const amostraNossa = await sb.select('cmp_orders', { columns: 'numero,nota_fiscal', where: 'nota_fiscal=not.is.null', limit: 10 });
  return { totalWaybills: list.length, rows, amostraNossosPedidosComNF: amostraNossa };
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
async function blingSyncOne(n, out) {
  let d;
  try { const det = await blingGet(`/nfe/${n.id}`); d = det.j?.data || {}; } catch { return; }
  const numeroLoja = d.numeroPedidoLoja || n.numeroPedidoLoja;
  if (!numeroLoja) return;
  const tr = d.transporte || {};
  const vol = (tr.volumes || [])[0] || {};
  const codigo = vol.codigoRastreamento || null;
  const servico = vol.servico || tr.transportador?.nome || tr.etiqueta?.nome || '';
  const chave = d.chaveAcesso || null;
  const cpf = (d.contato && (d.contato.numeroDocumento || d.contato.cpfCnpj)) || null;
  const ordr = await sb.selectOne('cmp_orders', { where: `numero=eq.${encodeURIComponent(String(numeroLoja))}` });
  if (!ordr) { out.semMatch++; return; }
  const patch = {};
  if (d.numero) patch.nota_fiscal = String(d.numero);          // alinha NF com o J&T (mesmo numero da NFe)
  if (codigo) { patch.tracking_code = codigo; out.comCodigo++; }
  if (servico) { patch.transportadora = carrierKey(servico); patch.servico = servico; }
  patch.raw = { ...(ordr.raw || {}), chave_danfe: chave, cpf_cliente: cpf, bling_nfe_id: n.id };
  const naoFinal = !['enviado', 'entregue', 'atrasado', 'devolvido', 'cancelado'].includes(ordr.status);
  if (codigo && naoFinal) { patch.status = 'enviado'; if (!ordr.data_envio) patch.data_envio = new Date().toISOString(); out.marcadosEnviado++; }
  await sb.update('cmp_orders', `id=eq.${ordr.id}`, patch);
  out.atualizados++;
  if (out.amostra.length < 6) out.amostra.push({ pedido: numeroLoja, nf: patch.nota_fiscal, transportadora: patch.transportadora, temCodigo: !!codigo, temChave: !!chave });
}
async function blingSync(limite = 100, paginas = 1) {
  const out = { nfes: 0, atualizados: 0, comCodigo: 0, semMatch: 0, marcadosEnviado: 0, amostra: [] };
  for (let pagina = 1; pagina <= paginas; pagina++) {
    const nf = await blingGet(`/nfe?limite=${Math.min(limite, 100)}&pagina=${pagina}`);
    const list = nf.j?.data || [];
    if (!list.length) break;
    out.nfes += list.length;
    const chunk = 3;                                            // respeita rate-limit do Bling (3 req/s)
    for (let i = 0; i < list.length; i += chunk) {
      await Promise.all(list.slice(i, i + chunk).map((n) => blingSyncOne(n, out)));
      await new Promise((r) => setTimeout(r, 350));
    }
    if (list.length < Math.min(limite, 100)) break;
  }
  return out;
}
// ================================================================================

// ================= Entrega local: página do motoboy + Retirada =================
// Chave do entregador guardada num sentinel (não é env var — gera aqui).
async function motoboyKey() { const r = await sb.selectOne('cmp_rules', { where: 'name=eq.__motoboy_key__' }); return r?.then_json?.key || null; }
async function motoboySetup() {
  const key = 'mb-' + Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 6);
  const ex = await sb.selectOne('cmp_rules', { where: 'name=eq.__motoboy_key__', columns: 'id' });
  if (ex) await sb.update('cmp_rules', `id=eq.${ex.id}`, { then_json: { key } });
  else await sb.insert('cmp_rules', { name: '__motoboy_key__', enabled: false, priority: 99999, when_json: {}, then_json: { key } }, { returning: false });
  return key;
}
async function motoboyList() {
  const where = 'and=(transportadora.in.(local,motoboy),status.in.(faturado,em_separacao,enviado,aguardando_retirada,atrasado))';
  const rows = await sb.select('cmp_orders', { columns: 'id,numero,cliente_nome,destino,uf,servico,status,data_envio,skus,raw', where, order: 'criado_em.desc', limit: 300 });
  return rows.map((o) => ({
    id: o.id, numero: o.numero, cliente: o.cliente_nome, destino: o.destino, uf: o.uf,
    servico: o.servico, status: o.status,
    endereco: o.raw?.endereco_entrega || o.raw?.endereco || o.raw?.shipping_address || null,
    telefone: o.raw?.telefone || o.raw?.cliente_telefone || null,
    bordado: o.raw?.bordado || null,
  }));
}
async function motoboyEntregar(id, source = 'motoboy') {
  const o = await sb.selectOne('cmp_orders', { where: `id=eq.${id}` });
  if (!o) return { ok: false, error: 'pedido não encontrado' };
  if (o.status === 'entregue') return { ok: true, already: true, numero: o.numero };
  const now = new Date().toISOString();
  await sb.update('cmp_orders', `id=eq.${id}`, { status: 'entregue', data_entrega: now, acareacao_aberta: false, updated_at: now });
  await sb.insert('cmp_status_history', { order_id: id, from_status: o.status, to_status: 'entregue', source }, { returning: false });
  await sb.insert('cmp_events', { order_id: id, data: now, status: 'entregue', descricao: source === 'retirada' ? 'Retirada confirmada na loja' : 'Entrega confirmada pelo entregador', local: o.destino || '', hash: source + '|' + Date.now() }, { returning: false });
  try { await li.updateOrderStatus(o.li_id, 'entregue'); } catch {}
  return { ok: true, numero: o.numero };
}
// Desliga as regras de auto-entrega por tempo (substituídas pela confirmação manual).
async function disableTimeRules() {
  const rules = await sb.select('cmp_rules', { columns: 'id,name,then_json,enabled', where: 'enabled=eq.true' });
  let off = 0;
  for (const r of rules) {
    if (r.then_json?.setStatus === 'entregue') { await sb.update('cmp_rules', `id=eq.${r.id}`, { enabled: false }); off++; }
  }
  return { desligadas: off };
}
// ================= Bordado: puxa personalização direto da Loja Integrada =================
// Sonda profunda de um pedido para localizar onde a LI guarda a personalização.
async function bordadoProbe(numero) {
  const out = { numero };
  const host = 'https://api.awsli.com.br';
  async function get(path) {
    const u = new URL(path.startsWith('http') ? path : host + path);
    u.searchParams.set('chave_api', process.env.LI_CHAVE_API || '');
    u.searchParams.set('chave_aplicacao', process.env.LI_CHAVE_APLICACAO || '');
    const r = await fetch(u.toString(), { headers: { Accept: 'application/json' } });
    let j = null; try { j = await r.json(); } catch {}
    return { status: r.status, j };
  }
  // acha o pedido pelo número (ou o mais recente)
  const base = '/v1/pedido/';
  let ped = null;
  if (numero) { const f = await get(`${base}?numero=${numero}&limit=1`); ped = (f.j?.objects || [])[0]; }
  if (!ped) { const f = await get(`${base}?limit=1&order_by=-data_criacao`); ped = (f.j?.objects || [])[0]; }
  if (!ped) return { ...out, erro: 'nenhum pedido' };
  out.numero = ped.numero; out.pedido_id = ped.id;
  out.integration_data = ped.integration_data || null;
  // detalhe correto via resource_uri (host + uri)
  if (ped.resource_uri) { const d = await get(ped.resource_uri); out.detalhe_status = d.status; out.detalhe_campos = Object.keys(d.j || {}); out.detalhe_itens = (d.j?.itens || d.j?.items || []).length; if (d.j?.itens?.[0]) out.detalhe_item0 = d.j.itens[0]; }
  // itens do pedido (endpoints possíveis)
  for (const p of [`/v1/pedido_item/?pedido=${ped.id}&limit=50`, `/v1/pedido/${ped.id}/itens`, `/v1/pedido/${ped.id}/item`]) {
    const it = await get(p);
    const arr = it.j?.objects || it.j?.itens || (Array.isArray(it.j) ? it.j : []);
    if (it.status === 200 && arr.length) {
      out.itens_endpoint = p; out.itens_qtd = arr.length;
      out.itens = arr.slice(0, 4).map((i) => ({ campos: Object.keys(i), sku: i.sku, nome: i.nome || i.produto, personalizacao: i.personalizacao ?? i.personalizacoes ?? i.customizacao ?? i.customizacoes ?? i.opcoes ?? i.brinde ?? null, observacao: i.observacao ?? i.obs ?? null }));
      break;
    }
  }
  return out;
}

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
  // Rotas do ENTREGADOR/RETIRADA (públicas + CORS, protegidas por chave própria).
  if (req.query.motoboy) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    if (req.method === 'OPTIONS') return res.status(200).end();
    const act = req.query.motoboy;
    if (act === 'setup') { // gera a chave (protegido pelo secret do sistema)
      const prov = (req.headers.authorization || '').replace('Bearer ', '') || req.query.secret;
      if (prov !== process.env.CMP_CRON_SECRET) return res.status(401).json({ error: 'não autorizado' });
      const key = await motoboySetup();
      return res.status(200).json({ ok: true, key, link: `/entrega.html?k=${key}` });
    }
    const key = req.query.k || req.body?.k;
    const real = await motoboyKey();
    if (!real || key !== real) return res.status(401).json({ error: 'chave inválida' });
    try {
      if (act === 'list') return res.status(200).json({ ok: true, orders: await motoboyList() });
      if (act === 'entregar') return res.status(200).json(await motoboyEntregar(req.query.id || req.body?.id, req.body?.source || 'motoboy'));
    } catch (e) { return res.status(200).json({ ok: false, error: e.message }); }
    return res.status(400).json({ error: 'ação inválida' });
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
    if (req.query.jt === 'sync') return res.status(200).json(await jtSync(Number(req.query.paginas) || 3, Number(req.query.dias) || 30));
    if (req.query.jt === 'diag') return res.status(200).json(await jtDiag(Number(req.query.dias) || 30));
    if (req.query.bordado === 'probe') return res.status(200).json(await bordadoProbe(req.query.numero));
    if (req.query.admin === 'disableTimeRules') return res.status(200).json(await disableTimeRules());
    if (req.query.motoboy_key === 'get') return res.status(200).json({ key: await motoboyKey() });
    if (req.query.process === 'batch') return res.status(200).json(await processActiveBatch(Number(req.query.limit) || 40));

    // ===== Ciclo automático (cron diário): pipeline REAL, sem dados mock =====
    const out = { ranAt: new Date().toISOString() };
    try { out.bling = await blingSync(100, 1); } catch (e) { out.bling = { error: e.message }; }
    try { out.jt = await jtSync(3, 30); } catch (e) { out.jt = { error: e.message }; }
    try { out.cycle = await processActiveBatch(40); } catch (e) { out.cycle = { error: e.message }; }
    return res.status(200).json({ ok: true, ...out });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
}

// Processa um lote de pedidos ativos (rastreio Correios/ME + SLA + regras).
async function processActiveBatch(limit = 40) {
  const active = await sb.select('cmp_orders', {
    columns: 'id',
    where: 'and=(status.not.in.(entregue,cancelado,devolvido),tracking_code.not.is.null)',
    order: 'last_tracked_at.asc.nullsfirst', limit,
  });
  const results = [];
  for (const { id } of active) {
    try { results.push(await processOrder(id)); } catch (e) { results.push({ id, error: e.message }); }
  }
  return { processados: active.length, comAcao: results.filter((r) => r.actions && r.actions.length).length };
}
