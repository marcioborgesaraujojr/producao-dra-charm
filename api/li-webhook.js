// api/li-webhook.js
// Recebe eventos de pedido (Loja Integrada) e ENFILEIRA a notificação conforme os
// gatilhos ativos (at_gatilhos). O envio de fato (WhatsApp) é feito depois, quando
// o canal estiver conectado — aqui a mensagem entra em at_fila_envios como "pendente".
//
// Env (já existem): SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.
// Teste rápido (GET): /api/li-webhook?evento=order.paid&pedido=238387&nome=Marina&telefone=5585999990000
//
// Mapa de status da Loja Integrada -> nosso evento_code. Ajustar quando ligarmos o
// webhook real da LI (os nomes/ids exatos vêm no payload deles).
const MAP = {
  'pedido pago':'order.paid', 'pagamento aprovado':'order.paid', 'aprovado':'order.paid',
  'cancelado':'order.canceled', 'pagamento com falha':'order.canceled',
  'em separacao':'order.separating', 'em separação':'order.separating', 'separando':'order.separating',
  'entregue':'order.delivered',
  'enviado':'order.shipped', 'enviada':'order.shipped', 'postado':'order.shipped', 'em transito':'order.shipped', 'em trânsito':'order.shipped', 'em transporte':'order.shipped',
  'confeccionando':'order.producing', 'em producao':'order.producing',
  'aguardando retirada':'order.awaiting_pickup', 'estornado':'order.refunded',
  'aguardando pagamento':'order.awaiting_payment_no_method', 'pix':'order.awaiting_payment_pix',
  'boleto':'order.boleto_printed', 'nota fiscal emitida':'invoice.issued', 'nota emitida':'invoice.issued'
};

const SB = () => process.env.SUPABASE_URL;
const KEY = () => process.env.SUPABASE_SERVICE_ROLE_KEY;
async function sb(path, opts = {}) {
  const r = await fetch(SB() + '/rest/v1/' + path, {
    ...opts,
    headers: { apikey: KEY(), Authorization: 'Bearer ' + KEY(), 'Content-Type': 'application/json', ...(opts.headers || {}) }
  });
  const txt = await r.text(); let d = null; try { d = txt ? JSON.parse(txt) : null; } catch (e) { d = txt; }
  if (!r.ok) throw new Error('SB ' + r.status + ': ' + JSON.stringify(d));
  return d;
}
function preencher(msg, ctx) {
  return String(msg || '')
    .replace(/\{\{\s*nome\s*\}\}/gi, ctx.nome || 'cliente')
    .replace(/\{\{\s*pedido\s*\}\}/gi, ctx.pedido || '')
    .replace(/\{\{\s*produto\s*\}\}/gi, ctx.produto || '')
    .replace(/\{\{\s*codigo_rastreio\s*\}\}/gi, ctx.codigo_rastreio || '')
    .replace(/\{\{\s*valor\s*\}\}/gi, ctx.valor || '')
    .replace(/\{\{\s*loja\s*\}\}/gi, ctx.loja || 'Dra. Charm');
}

// Quando o pedido vira "enviado"/"entregue", move o card do quadro de Personalização
// pra coluna "Bordado Expedido" (assim a expedição não precisa mover na mão).
async function moverParaExpedido(pedido) {
  if (!pedido) return { moved: false, motivo: 'sem pedido' };
  const boards = await sb('boards?select=id&name=ilike.*personaliza*&limit=1');
  const boardId = Array.isArray(boards) && boards[0] && boards[0].id;
  if (!boardId) return { moved: false, motivo: 'board Personalização não encontrado' };
  const listas = await sb('lists?select=id&board_id=eq.' + boardId + '&name=ilike.*expedido*&limit=1');
  const expId = Array.isArray(listas) && listas[0] && listas[0].id;
  if (!expId) return { moved: false, motivo: 'coluna "Bordado Expedido" não encontrada' };
  const todasListas = await sb('lists?select=id&board_id=eq.' + boardId);
  const listIds = (todasListas || []).map(l => l.id);
  const cards = await sb('cards?select=id,list_id&archived=eq.false&pedido_numero=eq.' + encodeURIComponent(String(pedido)));
  const card = (cards || []).find(c => listIds.includes(c.list_id)) || (cards || [])[0];
  if (!card) return { moved: false, motivo: 'card não encontrado pro pedido ' + pedido };
  if (card.list_id === expId) return { moved: false, motivo: 'já estava em Bordado Expedido' };
  await sb('cards?id=eq.' + card.id, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ list_id: expId, position: Date.now() }) });
  return { moved: true, card_id: card.id };
}

// núcleo: registra evento, acha gatilho ativo e enfileira
async function processar({ evento_code, pedido, nome, telefone, produto, valor, rastreio, payload }) {
  await sb('at_eventos', { method: 'POST', body: JSON.stringify({
    loja: 'loja_integrada', evento_code, pedido_numero: pedido, cliente_nome: nome, telefone,
    payload: payload || null, processado: true
  })});
  if (!evento_code) return { ok: true, enfileirado: false, motivo: 'sem evento_code' };

  const gats = await sb('at_gatilhos?loja=eq.loja_integrada&evento_code=eq.' + encodeURIComponent(evento_code) + '&ativo=eq.true&select=*');
  if (!Array.isArray(gats) || !gats.length) return { ok: true, enfileirado: false, motivo: 'nenhum gatilho ativo' };

  const g = gats[0];
  const conteudo = preencher(g.mensagem, { nome, pedido, produto, valor, codigo_rastreio: rastreio });
  await sb('at_fila_envios', { method: 'POST', body: JSON.stringify({
    gatilho_id: g.id, telefone: telefone || null, canal: g.canal || 'whatsapp_oficial',
    conteudo, status: 'pendente', evento_code, pedido_numero: pedido || null
  })});
  return { ok: true, enfileirado: true, gatilho: g.evento_nome };
}

function deriveCode(body, q) {
  if (q && q.evento) return q.evento;
  if (body && body.evento_code) return body.evento_code;
  const status = String((body && (body.status || body.situacao || body.situacao_nome)) || (q && q.status) || '').toLowerCase().trim();
  if (MAP[status]) return MAP[status];
  for (const k in MAP) if (status.includes(k)) return MAP[k];
  return null;
}

export default async function handler(req, res) {
  try {
    const q = req.query || {};
    if (req.method === 'GET') {
      // modo teste
      const evento_code = deriveCode(null, q);
      const out = await processar({ evento_code, pedido: q.pedido, nome: q.nome, telefone: q.telefone });
      let expedicao = null;
      if (evento_code === 'order.shipped' || evento_code === 'order.delivered') { try { expedicao = await moverParaExpedido(q.pedido); } catch (e) { expedicao = { moved: false, erro: e.message }; } }
      return res.status(200).json({ ...out, expedicao });
    }
    if (req.method !== 'POST') return res.status(405).json({ error: 'Método não permitido' });
    let body = req.body; if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
    const evento_code = deriveCode(body, q);
    const pedido = body.pedido || body.numero || body.order_id || (body.order && (body.order.number || body.order.id));
    const cli = body.cliente || body.customer || {};
    const nome = body.nome || cli.nome || cli.name || (cli.first_name ? (cli.first_name + ' ' + (cli.last_name || '')).trim() : null);
    const telefone = body.telefone || cli.telefone || cli.phone || null;
    const out = await processar({ evento_code, pedido, nome, telefone, payload: body });
    let expedicao = null;
    if (evento_code === 'order.shipped' || evento_code === 'order.delivered') { try { expedicao = await moverParaExpedido(pedido); } catch (e) { expedicao = { moved: false, erro: e.message }; } }
    return res.status(200).json({ ...out, expedicao });
  } catch (err) {
    console.error('li-webhook erro:', err.message);
    return res.status(200).json({ ok: false, error: err.message });
  }
}
