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
// Aplica um waybill do J&T a um pedido já casado (retorna a promise do update).
function applyWaybill(ord, w, out) {
  const patch = { transportadora: 'jt', updated_at: new Date().toISOString() };
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
  out.atualizados++;
  return sb.update('cmp_orders', `id=eq.${ord.id}`, patch);
}
// Sync do J&T VIP em LOTE: 2 queries por página (NF + chave) em vez de 1 por waybill.
async function jtSync(paginas = 3, dias = 29) {
  const s = await jtLoad();
  if (!s?.token) return { erro: 'J&T VIP sem token — refazer login no painel VIP' };
  const t0 = `${ymd(new Date(Date.now() - dias * 86400000))} 00:00:00`;
  const t1 = `${ymd(new Date())} 23:59:59`;
  const cols = 'id,numero,status,nota_fiscal,data_envio,data_entrega,acareacao_aberta,raw';
  const out = { paginas: 0, waybills: 0, atualizados: 0, viaChave: 0, viaNF: 0, marcadosEnviado: 0, entregues: 0, semMatch: 0 };
  for (let current = 1; current <= paginas; current++) {
    const { status, j } = await jtPost('/ccm-vip/waybillOrder/page', { current, size: 50, time: [t0, t1], billType: 2, inputTimeStart: t0, inputTimeEnd: t1 });
    if (status !== 200 || j?.code !== 1) { out.erro = `status ${status} code ${j?.code || '?'} (janela max ~30 dias; ou token expirado)`; break; }
    const list = j.data?.records || j.data?.list || [];
    if (!list.length) break;
    out.paginas++; out.waybills += list.length;
    // 1) coleta chaves de casamento e busca em lote
    const nfSet = new Set(), chaveSet = new Set();
    for (const w of list) { nfCandidates(w.invoiceNo).forEach((c) => { if (/^\d+$/.test(c)) nfSet.add(c); }); if (w.invoiceAccessKey) chaveSet.add(w.invoiceAccessKey); }
    const byNF = {}, byChave = {};
    if (nfSet.size) { const rows = await sb.select('cmp_orders', { columns: cols, where: `nota_fiscal=in.(${[...nfSet].join(',')})`, limit: 300 }); for (const r of rows) if (r.nota_fiscal) byNF[r.nota_fiscal] = r; }
    if (chaveSet.size) { const rows = await sb.select('cmp_orders', { columns: cols, where: `raw->>chave_danfe=in.(${[...chaveSet].join(',')})`, limit: 300 }); for (const r of rows) if (r.raw?.chave_danfe) byChave[r.raw.chave_danfe] = r; }
    // 2) casa em memória e atualiza em paralelo (lotes de 10)
    const updates = [];
    for (const w of list) {
      let ord = w.invoiceAccessKey ? byChave[w.invoiceAccessKey] : null, via = 'chave';
      if (!ord) { for (const c of nfCandidates(w.invoiceNo)) { if (byNF[c]) { ord = byNF[c]; via = 'nf'; break; } } }
      if (!ord) { out.semMatch++; continue; }
      via === 'chave' ? out.viaChave++ : out.viaNF++;
      updates.push(applyWaybill(ord, w, out));
    }
    for (let i = 0; i < updates.length; i += 10) await Promise.all(updates.slice(i, i + 10));
    if (list.length < 50) break;
  }
  return out;
}
// Diagnóstico do casamento J&T: mostra os valores reais e se casam.
async function jtDiag(dias = 29) {
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
  const realServico = vol.servico || '';                        // serviço REAL (PAC/SEDEX/...), não nome de empresa
  const carrierSrc = realServico || tr.transportador?.nome || tr.etiqueta?.nome || '';
  const carrierConhecida = /correios|pac|sedex|jt|j&t|melhor\s*envio|total\s*express|motoboy|retir|pessoal/i.test(carrierSrc);
  const chave = d.chaveAcesso || null;
  const cpf = (d.contato && (d.contato.numeroDocumento || d.contato.cpfCnpj)) || null;
  const ordr = await sb.selectOne('cmp_orders', { where: `numero=eq.${encodeURIComponent(String(numeroLoja))}` });
  if (!ordr) { out.semMatch++; return; }
  const patch = {};
  if (d.numero) patch.nota_fiscal = String(d.numero);          // alinha NF com o J&T (mesmo numero da NFe)
  if (codigo) { patch.tracking_code = codigo; out.comCodigo++; }
  if (carrierConhecida) patch.transportadora = carrierKey(carrierSrc);   // só troca se casar de verdade (não força Correios)
  patch.servico = realServico || null;                                   // limpa nome de empresa que ficava aqui
  const nfLink = d.linkDanfe || d.linkPDF || null;   // link do PDF da NF (igual "Ver NF" do cademeupedido)
  patch.raw = { ...(ordr.raw || {}), chave_danfe: chave, cpf_cliente: cpf, bling_nfe_id: n.id, nf_link: nfLink };
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
  const where = 'and=(transportadora.in.(local,motoboy,retirada),status.in.(faturado,em_separacao,enviado,aguardando_retirada,atrasado))';
  const rows = await sb.select('cmp_orders', { columns: 'id,numero,cliente_nome,destino,uf,servico,status,transportadora,data_envio,skus,raw', where, order: 'criado_em.desc', limit: 300 });
  return rows.map((o) => ({
    id: o.id, numero: o.numero, cliente: o.cliente_nome, destino: o.destino, uf: o.uf,
    servico: o.servico, status: o.status, transportadora: o.transportadora,
    endereco: o.raw?.endereco_entrega || o.raw?.endereco || o.raw?.shipping_address || null,
    telefone: (o.raw?.cliente_contato && o.raw.cliente_contato.telefone) || o.raw?.telefone || null,
    bordado: o.raw?.bordado || null,
  }));
}
// Reclassifica pedidos 'local' antigos em motoboy / retirada (pelo nome do serviço).
async function reclassLocal() {
  const out = { motoboy: 0, retirada: 0 };
  for (let loop = 0; loop < 40; loop++) {
    const rows = await sb.select('cmp_orders', { columns: 'id,servico', where: 'transportadora=eq.local', limit: 200 });
    if (!rows.length) break;
    for (const r of rows) {
      const s = (r.servico || '').toLowerCase();
      const t = /retir|pessoal|na loja|balc/.test(s) ? 'retirada' : 'motoboy';
      await sb.update('cmp_orders', `id=eq.${r.id}`, { transportadora: t });
      out[t]++;
    }
  }
  return out;
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
// Semeia regras-padrão úteis (idempotente por nome).
async function seedRules() {
  const defaults = [
    { name: 'Correios sem rastreio há 2 dias → alertar equipe', priority: 50, when_json: { carrier: ['correios'], statusIn: ['enviado'], noTrackingCode: true, daysSinceSentGte: 2 }, then_json: { alertInternal: true } },
    { name: 'Correios atrasado → abrir acareação', priority: 60, when_json: { carrier: ['correios'], statusIn: ['atrasado'] }, then_json: { openAcareacao: true, alertInternal: true } },
  ];
  const out = { criadas: 0, existentes: 0 };
  for (const d of defaults) {
    const ex = await sb.selectOne('cmp_rules', { where: `name=eq.${encodeURIComponent(d.name)}`, columns: 'id' });
    if (ex) { out.existentes++; continue; }
    await sb.insert('cmp_rules', { ...d, enabled: true, when_json: d.when_json, then_json: d.then_json }, { returning: false });
    out.criadas++;
  }
  return out;
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
const LI_HOST = 'https://api.awsli.com.br';
async function liDetGet(path) {
  const u = new URL(path.startsWith('http') ? path : LI_HOST + path);
  u.searchParams.set('chave_api', process.env.LI_CHAVE_API || '');
  u.searchParams.set('chave_aplicacao', process.env.LI_CHAVE_APLICACAO || '');
  const r = await fetch(u.toString(), { headers: { Accept: 'application/json' } });
  let j = null; try { j = await r.json(); } catch {}
  return { status: r.status, j };
}
// Extrai a personalização (bordado) de um pedido detalhado da LI.
function extractBordado(d) {
  const linhas = [];
  for (const it of (d.itens || [])) {
    const campos = ['personalizacao', 'personalizacoes', 'customizacao', 'customizacoes', 'opcoes', 'brinde', 'observacao', 'obs', 'personalizacao_texto'];
    let pers = null;
    for (const c of campos) if (it[c] != null && it[c] !== '' && !(Array.isArray(it[c]) && !it[c].length)) { pers = it[c]; break; }
    if (pers) linhas.push({ sku: it.sku, nome: it.nome, personalizacao: pers });
  }
  const obs = (d.cliente_obs || '').trim();
  if (!linhas.length && !obs) return null;
  return { itens: linhas, cliente_obs: obs || null };
}
// Sonda: varre pedidos recentes procurando onde a LI guarda a personalização.
async function bordadoProbe(numero) {
  const out = { achados: [], varridos: 0 };
  const lst = await liDetGet(`/v1/pedido/?limit=40&order_by=-data_criacao`);
  const objs = lst.j?.objects || [];
  for (const o of objs) {
    if (!o.resource_uri) continue;
    const det = await liDetGet(o.resource_uri); const d = det.j || {};
    out.varridos++;
    const b = extractBordado(d);
    const camposComValor = (d.itens || []).flatMap((it) => Object.entries(it).filter(([k, v]) => v && !['produto', 'produto_pai', 'pedido'].includes(k) && typeof v === 'object').map(([k]) => k));
    if (b || (d.cliente_obs || '').trim()) out.achados.push({ numero: d.numero, cliente_obs: d.cliente_obs, bordado: b, item_campos_objeto: [...new Set(camposComValor)], item0: (d.itens || [])[0] });
    if (out.achados.length >= 4) break;
  }
  if (!out.achados.length) { const det = await liDetGet(objs[0].resource_uri); out.amostra_item = (det.j?.itens || [])[0]; out.amostra_cliente_obs = det.j?.cliente_obs; }
  return out;
}
const LI_SIT_TO_INTERNAL = { pedido_pago: 'pago', pedido_enviado: 'enviado', pedido_entregue: 'entregue', pedido_cancelado: 'cancelado', pedido_devolvido: 'devolvido', aguardando_pagamento: 'criado', pedido_em_separacao: 'em_separacao', pedido_faturado: 'faturado' };
// DIAGNÓSTICO: mostra a estrutura crua do produto na LI p/ descobrir onde está a imagem.
async function prodImgProbe(numero) {
  let lst = numero ? await liDetGet(`/v1/pedido/?numero=${encodeURIComponent(numero)}&limit=1`) : { j: {} };
  let o = (lst.j?.objects || [])[0];
  if (!o) { lst = await liDetGet(`/v1/pedido/?limit=1&order_by=-data_criacao`); o = (lst.j?.objects || [])[0]; }
  if (!o) return { erro: 'nenhum pedido na LI', numero };
  const det = await liDetGet(o.resource_uri); const d = det.j || {};
  const it = (d.itens || [])[0] || {};
  const out = { numero: d.numero, item0_campos: Object.keys(it), produto_uri: it.produto || null, sku: it.sku };
  if (it.produto) {
    const pr = await liDetGet(it.produto); const p = pr.j || {};
    out.produto_status = pr.status;
    out.produto_campos = Object.keys(p);
    out.imagens_len = Array.isArray(p.imagens) ? p.imagens.length : null;
    out.imagens0 = Array.isArray(p.imagens) ? p.imagens[0] : null;
    out.imagem_principal = p.imagem_principal ?? null;
    // busca o sub-recurso da imagem principal (onde ficam as URLs reais)
    if (typeof p.imagem_principal === 'string' && p.imagem_principal.startsWith('/')) { const im = await liDetGet(p.imagem_principal); out.imagem_principal_obj = im.j; }
    if (typeof out.imagens0 === 'string' && out.imagens0.startsWith('/')) { const im = await liDetGet(out.imagens0); out.imagens0_obj = im.j; }
    // Loja Integrada guarda imagem em endpoint separado: /produto_imagem/?produto=ID
    const pid = String(it.produto || '').split('/').filter(Boolean).pop();
    if (pid) { const pi = await liDetGet(`/v1/produto_imagem/?produto=${pid}&limit=3`); out.produto_imagem_qtd = (pi.j?.objects || []).length; out.produto_imagem_0 = (pi.j?.objects || [])[0] || null; }
    // variação não tem imagem — busca no produto PAI
    const paiUri = it.produto_pai || p.pai || null;
    out.pai_uri = paiUri;
    if (paiUri) { const paiId = String(paiUri).split('/').filter(Boolean).pop(); const pip = await liDetGet(`/v1/produto_imagem/?produto=${paiId}&limit=2`); out.pai_imagem_qtd = (pip.j?.objects || []).length; out.pai_imagem_0 = (pip.j?.objects || [])[0] || null; }
  }
  return out;
}
// Cache de imagem de produto (produtos se repetem entre pedidos).
const _prodImg = new Map();
const LI_CDN = 'https://cdn.awsli.com.br/';
// Imagem na Loja Integrada: endpoint /produto_imagem/?produto=ID, campo "caminho".
// Variações (tamanho) não têm imagem — ela fica no produto PAI. Por isso tentamos os dois.
async function imagemPorId(uri) {
  const id = String(uri || '').split('/').filter(Boolean).pop();
  if (!id) return null;
  const r = await liDetGet(`/v1/produto_imagem/?produto=${id}&limit=5&order_by=posicao`);
  const objs = r.j?.objects || [];
  const o = objs.find((x) => x.principal) || objs[0];
  if (o?.caminho) return LI_CDN + String(o.caminho).replace(/^\/+/, '');
  return null;
}
async function produtoImagem(prodUri, paiUri) {
  const key = prodUri || paiUri;
  if (!key) return null;
  if (_prodImg.has(key)) return _prodImg.get(key);
  let img = null;
  try {
    img = await imagemPorId(prodUri);
    if (!img && paiUri) img = await imagemPorId(paiUri);
  } catch {}
  _prodImg.set(key, img);
  return img;
}
// ---- Backfill de imagens via mapa SKU->URL (catálogo é pequeno; pedidos são milhares) ----
const IMGMAP_KEY = '__prod_img_map__';
const IMGCUR_KEY = '__img_apply_cursor__';
async function imgMapLoad() { const r = await sb.selectOne('cmp_rules', { where: `name=eq.${IMGMAP_KEY}` }); return r?.then_json || {}; }
async function imgMapSave(map) {
  const ex = await sb.selectOne('cmp_rules', { where: `name=eq.${IMGMAP_KEY}`, columns: 'id' });
  if (ex) await sb.update('cmp_rules', `id=eq.${ex.id}`, { then_json: map });
  else await sb.insert('cmp_rules', { name: IMGMAP_KEY, enabled: false, priority: 99999, when_json: {}, then_json: map }, { returning: false });
}
// Constrói/atualiza o mapa SKU->URL a partir do catálogo da LI (chunk por offset).
async function imgMapBuild(offset = 0, paginas = 20) {
  const map = await imgMapLoad();
  let off = offset, novos = 0, vistos = 0, fim = false;
  for (let k = 0; k < paginas; k++) {
    const r = await liDetGet(`/v1/produto/?limit=50&offset=${off}`);
    const objs = r.j?.objects || [];
    if (!objs.length) { fim = true; break; }
    for (const p of objs) {
      vistos++;
      if (!p.sku || map[p.sku]) continue;
      let img = null;
      try { img = await imagemPorId(p.resource_uri); if (!img && p.pai) img = await imagemPorId(p.pai); } catch {}
      if (img) { map[p.sku] = img; novos++; }
    }
    off += 50;
    if (!r.j?.meta?.next) { fim = true; break; }
  }
  await imgMapSave(map);
  return { proximoOffset: fim ? -1 : off, fim, totalSkus: Object.keys(map).length, novos, vistos };
}
// Aplica o mapa aos pedidos (preenche raw.produtos[].imagem por SKU), do mais novo p/ o mais antigo.
async function imgMapApply(cursor = 0, limite = 500) {
  const map = await imgMapLoad();
  const cur = cursor || 9999999999;
  const orders = await sb.select('cmp_orders', { columns: 'id,raw', where: `id=lt.${cur}`, order: 'id.desc', limit: limite });
  let atualizados = 0, ultimo = cur;
  for (const o of orders) {
    ultimo = o.id;
    const prod = o.raw?.produtos;
    if (!Array.isArray(prod) || !prod.length) continue;
    let mudou = false;
    for (const it of prod) { if (!it.imagem && it.sku && map[it.sku]) { it.imagem = map[it.sku]; mudou = true; } }
    if (mudou) { await sb.update('cmp_orders', `id=eq.${o.id}`, { raw: { ...o.raw, produtos: prod } }); atualizados++; }
  }
  const fim = orders.length < limite;
  // guarda cursor p/ o cron continuar
  try {
    const ex = await sb.selectOne('cmp_rules', { where: `name=eq.${IMGCUR_KEY}`, columns: 'id' });
    const val = { cursor: fim ? 0 : ultimo, fim, updated: new Date().toISOString() };
    if (ex) await sb.update('cmp_rules', `id=eq.${ex.id}`, { then_json: val });
    else await sb.insert('cmp_rules', { name: IMGCUR_KEY, enabled: false, priority: 99999, when_json: {}, then_json: val }, { returning: false });
  } catch {}
  return { processados: orders.length, atualizados, ultimoId: ultimo, fim, skusNoMapa: Object.keys(map).length };
}
// Produtos do pedido (nome, sku, qtd, preço, tamanho, imagem) — igual ao original.
async function mapProdutos(d, comImagem = true) {
  const out = [];
  for (const i of (d.itens || [])) {
    let imagem = null;
    if (comImagem && (i.produto || i.produto_pai)) imagem = await produtoImagem(i.produto, i.produto_pai);
    out.push({ nome: i.nome, sku: i.sku, qtd: Number(i.quantidade || 1), preco: Number(i.preco_venda || i.preco_subtotal || 0), tamanho: i.variacao ? (Object.values(i.variacao)[0] || {}).nome : null, imagem });
  }
  return out;
}
function acharTelefone(obj) {
  if (!obj) return null;
  const campos = ['telefone', 'celular', 'fone', 'telefone_celular', 'telefone_principal', 'telefone_comercial', 'whatsapp', 'phone', 'phone_number'];
  for (const c of campos) if (obj[c]) return String(obj[c]);
  const arr = obj.telefones || obj.contatos || obj.phones;
  if (Array.isArray(arr) && arr[0]) { const t = arr[0]; return String(t.numero || t.telefone || t.number || t.value || t); }
  return null;
}
function contatoCliente(cli, end, d) {
  const tel = acharTelefone(cli) || acharTelefone(end) || acharTelefone(d) || (d && (d.cliente_telefone || d.telefone)) || null;
  return { nome: cli.nome || (end && end.nome) || null, telefone: tel, documento: (cli.cpf || cli.cnpj || (end && (end.cpf || end.cnpj)) || '').replace(/\D/g, '') || null };
}
// Sonda: onde a LI guarda o telefone do cliente (para o botão "Falar com cliente").
async function clienteProbe() {
  const lst = await liDetGet(`/v1/pedido/?limit=6&order_by=-data_criacao`);
  const out = { amostras: [] };
  for (const o of (lst.j?.objects || [])) {
    const det = await liDetGet(o.resource_uri); const d = det.j || {};
    let cli = d.cliente; if (typeof cli === 'string' && cli.startsWith('/api')) { const cr = await liDetGet(cli); cli = cr.j || {}; }
    cli = cli || {};
    out.amostras.push({ numero: d.numero, cliente_campos: Object.keys(cli), cliente_amostra: cli, telefone_detectado: acharTelefone(cli) || acharTelefone(d.endereco_entrega) || acharTelefone(d), pedido_campos_tel: Object.keys(d).filter((k) => /tel|fone|phone|whats|cel/i.test(k)) });
    if (out.amostras.length >= 2) break;
  }
  return out;
}
// Enriquecimento + IMPORTAÇÃO via LI: puxa pedidos recentes; cria os que ainda
// não existem (preenche o gap desde a migração) e enriquece endereço/rastreio.
async function liEnrich(paginas = 3, importar = true, comImagem = true, desde = 0) {
  const out = { pedidos: 0, atualizados: 0, criados: 0, comEndereco: 0, comRastreio: 0, comProdutos: 0, comTelefone: 0, erros: 0, desde };
  for (let p = 0; p < paginas; p++) {
    const lst = await liDetGet(`/v1/pedido/?limit=20&offset=${(desde + p) * 20}&order_by=-data_criacao`);
    const objs = lst.j?.objects || [];
    if (!objs.length) break;
    for (const o of objs) {
      out.pedidos++;
      try {
        const det = await liDetGet(o.resource_uri); const d = det.j || {};
        const numero = String(d.numero || o.numero);
        const end = d.endereco_entrega || null;
        const envio = (d.envios || [])[0] || {};
        const codigo = envio.objeto || envio.codigo_rastreio || envio.rastreio || null;
        const forma = envio.forma_envio_nome || envio.nome || '';
        const sit = (d.situacao && (d.situacao.codigo || d.situacao)) || '';
        // cliente pode vir como objeto ou URI
        let cli = d.cliente;
        if (typeof cli === 'string' && cli.startsWith('/api')) { const cr = await liDetGet(cli); cli = cr.j || {}; }
        cli = cli || {};
        const contato = contatoCliente(cli, end, d);
        if (contato.telefone) out.comTelefone++;
        const produtos = await mapProdutos(d, comImagem);
        const ord = await sb.selectOne('cmp_orders', { columns: 'id,raw,tracking_code,transportadora,status', where: `numero=eq.${numero}` });
        if (!ord) {
          if (!importar) continue;
          const row = {
            li_id: numero, numero, nota_fiscal: '',
            cliente_nome: contato.nome || '', cliente_email: (cli.email || '').toLowerCase(),
            cliente_cpf: contato.documento || '',
            destino: end ? [end.cidade, end.estado || end.uf].filter(Boolean).join('/') : '', uf: (end && (end.estado || end.uf)) || '',
            preco: Number(d.valor_total || 0), transportadora: carrierKey(forma), servico: forma,
            tracking_code: codigo || null, status: LI_SIT_TO_INTERNAL[sit] || 'criado',
            skus: (d.itens || []).map((i) => i.sku).filter(Boolean),
            criado_em: d.data_criacao || new Date().toISOString(),
            raw: { endereco_entrega: end, cliente_obs: d.cliente_obs || null, li_id_interno: d.id, produtos, cliente_contato: contato },
          };
          await sb.insert('cmp_orders', row, { returning: false });
          out.criados++; if (produtos.length) out.comProdutos++; continue;
        }
        const raw = { ...(ord.raw || {}) };
        if (end) { raw.endereco_entrega = end; out.comEndereco++; }
        if (d.cliente_obs) raw.cliente_obs = d.cliente_obs;
        if (produtos.length) { raw.produtos = produtos; out.comProdutos++; }
        raw.cliente_contato = contato;
        const patch = { raw };
        if (codigo && !ord.tracking_code) { patch.tracking_code = codigo; out.comRastreio++; }
        if (forma && (!ord.transportadora || ord.transportadora === 'correios')) { patch.transportadora = carrierKey(forma); patch.servico = forma; }
        await sb.update('cmp_orders', `id=eq.${ord.id}`, patch);
        out.atualizados++;
      } catch (e) { out.erros++; }
    }
  }
  return out;
}
// Bordado REAL: une a tabela `cards` (preenchida pela extensão) ao pedido, pelo
// número. Copia nome/profissão/cor/fonte para cmp_orders.raw.bordado — sem raspagem
// extra. Substitui a "gambiarra" de o módulo depender da extensão diretamente.
async function bordadoLink(limite = 1500) {
  const cards = await sb.select('cards', { columns: 'pedido_numero,bordado_tipo,bordado_linha1,bordado_linha2,bordado_cor_nome,bordado_cor_hex,bordado_fonte,bordado_lado,bordado_detalhes', where: 'bordado_linha1=not.is.null', order: 'created_at.desc', limit: limite });
  const byPed = {};
  for (const c of cards) { if (c.pedido_numero) (byPed[c.pedido_numero] = byPed[c.pedido_numero] || []).push(c); }
  const numeros = Object.keys(byPed);
  const out = { cards: cards.length, pedidos: numeros.length, linkados: 0, semPedido: 0 };
  for (let i = 0; i < numeros.length; i += 50) {
    const chunk = numeros.slice(i, i + 50);
    const rows = await sb.select('cmp_orders', { columns: 'id,numero,raw', where: `numero=in.(${chunk.join(',')})`, limit: 100 });
    const map = {}; for (const r of rows) map[r.numero] = r;
    const ups = [];
    for (const numero of chunk) {
      const ord = map[numero]; if (!ord) { out.semPedido++; continue; }
      const bordado = byPed[numero].map((c) => ({ tipo: c.bordado_tipo, linha1: c.bordado_linha1, linha2: c.bordado_linha2, cor: c.bordado_cor_nome, cor_hex: c.bordado_cor_hex, fonte: c.bordado_fonte, lado: c.bordado_lado, detalhes: c.bordado_detalhes }));
      ups.push(sb.update('cmp_orders', `id=eq.${ord.id}`, { raw: { ...(ord.raw || {}), bordado } }));
      out.linkados++;
    }
    await Promise.all(ups);
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
    if (req.query.jt === 'diag') return res.status(200).json(await jtDiag(Number(req.query.dias) || 29));
    if (req.query.bordado === 'probe') return res.status(200).json(await bordadoProbe(req.query.numero));
    if (req.query.probe === 'prodimg') return res.status(200).json(await prodImgProbe(req.query.numero));
    if (req.query.imgmap === 'build') return res.status(200).json(await imgMapBuild(Number(req.query.offset) || 0, Number(req.query.paginas) || 20));
    if (req.query.imgmap === 'apply') return res.status(200).json(await imgMapApply(Number(req.query.cursor) || 0, Number(req.query.limite) || 500));
    if (req.query.probe === 'cliente') return res.status(200).json(await clienteProbe());
    if (req.query.enrich === 'li') return res.status(200).json(await liEnrich(Number(req.query.paginas) || 3, true, req.query.imagens !== '0', Number(req.query.desde) || 0));
    if (req.query.bordado === 'link') return res.status(200).json(await bordadoLink(Number(req.query.limite) || 1500));
    if (req.query.admin === 'disableTimeRules') return res.status(200).json(await disableTimeRules());
    if (req.query.rules === 'list') { const rs = await sb.select('cmp_rules', { order: 'priority.asc' }); return res.status(200).json({ total: rs.length, regras: rs.filter((r) => !String(r.name).startsWith('__')).map((r) => ({ id: r.id, name: r.name, enabled: r.enabled, priority: r.priority, when: r.when_json, then: r.then_json })) }); }
    if (req.query.rules === 'seed') { return res.status(200).json(await seedRules()); }
    if (req.query.reclass === 'local') return res.status(200).json(await reclassLocal());
    if (req.query.motoboy_key === 'get') return res.status(200).json({ key: await motoboyKey() });
    if (req.query.process === 'batch') return res.status(200).json(await processActiveBatch(Number(req.query.limit) || 40));

    // ===== Ciclo automático (cron diário): pipeline REAL, sem dados mock =====
    const out = { ranAt: new Date().toISOString() };
    try { out.liImport = await liEnrich(2, true, true); } catch (e) { out.liImport = { error: e.message }; }
    try { out.bling = await blingSync(80, 1); } catch (e) { out.bling = { error: e.message }; }
    try { out.jt = await jtSync(3, 29); } catch (e) { out.jt = { error: e.message }; }
    try { out.bordado = await bordadoLink(400); } catch (e) { out.bordado = { error: e.message }; }
    // continua o backfill de imagens de onde parou (até terminar todos os pedidos)
    try { const cs = await sb.selectOne('cmp_rules', { where: `name=eq.${IMGCUR_KEY}` }); const cur = cs?.then_json?.cursor || 0; out.imgBackfill = await imgMapApply(cur, 800); } catch (e) { out.imgBackfill = { error: e.message }; }
    try { out.cycle = await processActiveBatch(30); } catch (e) { out.cycle = { error: e.message }; }
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
