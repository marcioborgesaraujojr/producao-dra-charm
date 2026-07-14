// Admin: lista/detalhe de pedidos e ações (mudar status, rastrear agora,
// encerrar acareação). Protegido por sessão do Supabase (Bearer token).
import * as sb from '../lib/supabase.js';
import * as li from '../lib/li.js';
import { processOrder } from '../lib/engine.js';

async function requireAdmin(req, res) {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  const user = await sb.getUserFromToken(token);
  if (!user) { res.status(401).json({ error: 'não autorizado' }); return null; }
  return user;
}

export default async function handler(req, res) {
  if (!(await requireAdmin(req, res))) return;

  // ------- GET: lista ou detalhe -------
  if (req.method === 'GET') {
    const { id, status, q } = req.query;
    if (id) {
      const order = await sb.selectOne('cmp_orders', { where: `id=eq.${id}` });
      if (!order) return res.status(404).json({ error: 'não encontrado' });
      const events = await sb.select('cmp_events', { where: `order_id=eq.${id}`, order: 'data.desc' });
      const history = await sb.select('cmp_status_history', { where: `order_id=eq.${id}`, order: 'created_at.desc' });
      return res.status(200).json({ order, events, history });
    }
    let where = '';
    const conds = [];
    if (status) conds.push(`status=eq.${status}`);
    if (q) conds.push(`or=(numero.ilike.*${q}*,tracking_code.ilike.*${q}*,cliente_nome.ilike.*${q}*,cliente_email.ilike.*${q}*)`);
    if (conds.length) where = conds.join('&');
    const orders = await sb.select('cmp_orders', { where, order: 'criado_em.desc', limit: 500 });
    // contadores EXATOS via count (não limitado a 1000 linhas)
    const STATUSES = ['criado', 'pago', 'em_separacao', 'faturado', 'enviado', 'aguardando_retirada', 'atrasado', 'entregue', 'devolvido', 'cancelado'];
    const counts = {};
    const [total, acare, ...perStatus] = await Promise.all([
      sb.count('cmp_orders'),
      sb.count('cmp_orders', 'acareacao_aberta=eq.true'),
      ...STATUSES.map((s) => sb.count('cmp_orders', `status=eq.${s}`)),
    ]);
    counts._total = total; counts._acareacao = acare;
    STATUSES.forEach((s, i) => { counts[s] = perStatus[i] || 0; });
    return res.status(200).json({ orders, counts });
  }

  // ------- POST: ações -------
  if (req.method === 'POST') {
    const { action, id, status } = req.body || {};
    const order = await sb.selectOne('cmp_orders', { where: `id=eq.${id}` });
    if (!order) return res.status(404).json({ error: 'não encontrado' });

    if (action === 'setStatus') {
      await sb.update('cmp_orders', `id=eq.${id}`, { status, updated_at: new Date().toISOString() });
      await sb.insert('cmp_status_history', { order_id: id, from_status: order.status, to_status: status, source: 'manual' }, { returning: false });
      try { await li.updateOrderStatus(order.li_id, status); } catch {}
      return res.status(200).json({ ok: true });
    }
    if (action === 'track') { const r = await processOrder(Number(id)); return res.status(200).json({ ok: true, r }); }
    if (action === 'closeAcareacao') { await sb.update('cmp_orders', `id=eq.${id}`, { acareacao_aberta: false }); return res.status(200).json({ ok: true }); }
    return res.status(400).json({ error: 'ação inválida' });
  }

  res.status(405).json({ error: 'método não suportado' });
}
