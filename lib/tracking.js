// Rastreamento multi-transportadora.
// Correios via API oficial CWS (você tem contrato). Melhor Envio via API v2.
// J&T: tratado em massa pelo painel VIP (api/rastreio-sync jtSync), não aqui.
// Entrega local (motoboy/retirada): confirmação manual, sem rastreio externo.
// Sem credencial -> não inventa evento (a não ser TRACK_DEMO=true).
import * as sb from './supabase.js';

const DEMO = process.env.TRACK_DEMO === 'true';

function classify(desc = '') {
  const d = desc.toLowerCase();
  if (/entregue|entrega efetuada|objeto entregue/.test(d)) return 'entregue';
  if (/devolv|retornad|remetente/.test(d)) return 'devolvido';
  if (/aguardando retirada|dispon[ií]vel para retirada|retirar/.test(d)) return 'aguardando_retirada';
  return 'transito';
}
function summarize(events, forecast = null) {
  const n = events.map((e) => ({ ...e, _c: classify(e.descricao) }));
  return {
    found: events.length > 0, events,
    delivered: n.some((e) => e._c === 'entregue'),
    returned: n.some((e) => e._c === 'devolvido'),
    awaitingPickup: n.some((e) => e._c === 'aguardando_retirada'),
    forecast,
  };
}

export async function track(order) {
  const carrier = order.transportadora || 'correios';
  try {
    // entrega local/própria ("Personalizada", motoboy, retirada): confirmação manual
    if (carrier === 'local' || carrier === 'motoboy') return { found: false, events: [] };
    // J&T é sincronizado em massa pelo painel VIP (jtSync); aqui é no-op
    if (carrier === 'jt') return { found: false, events: [] };
    if (carrier === 'melhorenvio') return await trackMelhorEnvio(order);
    return await trackCorreios(order);
  } catch (err) {
    return { found: false, events: [], error: err.message };
  }
}

// ---------------- Correios CWS (oficial) ----------------
let _cwsToken = null, _cwsExp = 0;
async function cwsToken() {
  const usuario = process.env.CORREIOS_CWS_USUARIO;
  const senha = process.env.CORREIOS_CWS_SENHA;          // código de acesso do CWS
  const cartao = process.env.CORREIOS_CARTAO_POSTAGEM;
  if (!usuario || !senha || !cartao) return null;
  if (_cwsToken && Date.now() < _cwsExp - 60000) return _cwsToken;
  const res = await fetch('https://api.correios.com.br/token/v1/autentica/cartaopostagem', {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + Buffer.from(`${usuario}:${senha}`).toString('base64'),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ numero: cartao }),
  });
  if (!res.ok) throw new Error(`Correios auth ${res.status}`);
  const data = await res.json();
  _cwsToken = data.token;
  _cwsExp = data.expiraEm ? new Date(data.expiraEm).getTime() : Date.now() + 3600000;
  return _cwsToken;
}
async function trackCorreios(order) {
  const code = order.tracking_code;
  if (!code) return { found: false, events: [] };
  const token = await cwsToken();
  if (!token) return DEMO ? mockCorreios(order) : { found: false, events: [] };
  const res = await fetch(`https://api.correios.com.br/srorastro/v1/objetos/${code}?resultado=T`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Correios SRO ${res.status}`);
  const data = await res.json();
  const obj = (data.objetos || [])[0] || {};
  const events = (obj.eventos || []).map((e) => ({
    data: e.dtHrCriado || '',
    status: e.descricao || '',
    descricao: e.descricao || '',
    local: [e.unidade?.endereco?.cidade, e.unidade?.endereco?.uf].filter(Boolean).join('/'),
  }));
  return summarize(events);
}

// ---------------- Melhor Envio ----------------
async function meSentinelToken() {
  try { const r = await sb.selectOne('cmp_rules', { where: 'name=eq.__melhorenvio__' }); return r?.then_json?.token || null; } catch { return null; }
}
async function trackMelhorEnvio(order) {
  const token = process.env.MELHORENVIO_TOKEN || await meSentinelToken();
  if (!token) return DEMO ? mockCorreios(order) : { found: false, events: [] };
  const base = process.env.MELHORENVIO_SANDBOX === 'true' ? 'https://sandbox.melhorenvio.com.br' : 'https://melhorenvio.com.br';
  const res = await fetch(`${base}/api/v2/me/shipment/tracking`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': 'Suite Aragao (contato@dracharm.com.br)' },
    body: JSON.stringify({ orders: [order.tracking_code || order.li_id] }),
  });
  if (!res.ok) throw new Error(`MelhorEnvio ${res.status}`);
  const data = await res.json();
  const first = Object.values(data)[0] || {};
  const events = (first.tracking || first.events || []).map((e) => ({
    data: e.created_at || e.date || '', status: e.status || '',
    descricao: e.description || e.message || e.status || '', local: e.location || '',
  }));
  return summarize(events, first.delivery_estimate || null);
}

// ---------------- Mock / demonstração ----------------
function mockCorreios(order) {
  const sent = new Date(order.data_envio || order.criado_em);
  const days = Math.floor((Date.now() - sent.getTime()) / 86400000);
  const local = order.destino || 'São Paulo/SP';
  const evts = [];
  const push = (d, desc, loc) => evts.push({ data: new Date(sent.getTime() + d * 86400000).toISOString(), status: desc, descricao: desc, local: loc });
  push(0, 'Objeto postado', 'Agência de Origem');
  if (days >= 1) push(1, 'Objeto em trânsito - por favor aguarde', 'Unidade de Tratamento');
  if (days >= 3) push(3, 'Objeto saiu para entrega ao destinatário', local);
  if (days >= 5 && order.numero !== '100235') push(5, 'Objeto entregue ao destinatário', local);
  return summarize(evts.reverse());
}

export default { track };
