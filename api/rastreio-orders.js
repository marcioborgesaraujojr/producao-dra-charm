// Admin: lista/detalhe de pedidos e ações (mudar status, rastrear agora,
// encerrar acareação). Protegido por sessão do Supabase (Bearer token).
import * as sb from '../lib/supabase.js';
import * as li from '../lib/li.js';
import { processOrder } from '../lib/engine.js';
import * as oc from '../lib/ocorrencias.js';

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
    const { id, status, q, transportadora, nf, rastreio, acareacao, ocorrencia, meta, arquivados, analytics, desde } = req.query;
    if (meta === 'tipos') return res.status(200).json({ tipos: oc.TIPOS, emailConfigurado: oc.isConfigured() });
    if (analytics) {
      const from = desde || new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
      const rows = await sb.select('cmp_orders', {
        columns: 'transportadora,status,criado_em,data_envio,data_entrega,prazo_entrega',
        where: `criado_em=gte.${from}`, order: 'criado_em.desc', limit: 8000,
      });
      const DAY = 86400000;
      const CARRIER_NAME = { correios: 'Correios', jt: 'J&T Express', melhorenvio: 'Melhor Envio', total: 'Total Express', motoboy: 'Motoboy', retirada: 'Retirada', local: 'Local', sem: 'Sem Transportadora', '': 'Não identificada' };
      const groups = {}; const G = (k) => (groups[k] ||= { entregues: 0, noPrazo: 0, somaEntrega: 0, nEntrega: 0, somaPostagem: 0, nPostagem: 0 });
      const glob = G('__global__');
      for (const r of rows) {
        const key = r.transportadora || '';
        const g = G(key);
        if (r.data_entrega) {
          g.entregues++; glob.entregues++;
          if (r.prazo_entrega && new Date(r.data_entrega) <= new Date(r.prazo_entrega)) { g.noPrazo++; glob.noPrazo++; }
          if (r.data_envio) { const d = (new Date(r.data_entrega) - new Date(r.data_envio)) / DAY; if (d >= 0 && d < 120) { g.somaEntrega += d; g.nEntrega++; glob.somaEntrega += d; glob.nEntrega++; } }
        }
        if (r.data_envio && r.criado_em) { const d = (new Date(r.data_envio) - new Date(r.criado_em)) / DAY; if (d >= 0 && d < 120) { g.somaPostagem += d; g.nPostagem++; glob.somaPostagem += d; glob.nPostagem++; } }
      }
      const fmt = (g) => ({
        entregues: g.entregues,
        sla: g.entregues ? Math.round((g.noPrazo / g.entregues) * 10000) / 100 : null,
        tempoEntrega: g.nEntrega ? Math.round((g.somaEntrega / g.nEntrega) * 10) / 10 : null,
        tempoPostagem: g.nPostagem ? Math.round((g.somaPostagem / g.nPostagem) * 10) / 10 : null,
      });
      const porTransportadora = Object.keys(groups).filter((k) => k !== '__global__')
        .map((k) => ({ key: k, nome: CARRIER_NAME[k] || k, ...fmt(groups[k]) }))
        .filter((x) => x.entregues > 0)
        .sort((a, b) => (b.sla ?? -1) - (a.sla ?? -1));
      return res.status(200).json({ desde: from, total: rows.length, global: fmt(glob), porTransportadora });
    }
    if (id) {
      const order = await sb.selectOne('cmp_orders', { where: `id=eq.${id}` });
      if (!order) return res.status(404).json({ error: 'não encontrado' });
      const events = await sb.select('cmp_events', { where: `order_id=eq.${id}`, order: 'data.desc' });
      const history = await sb.select('cmp_status_history', { where: `order_id=eq.${id}`, order: 'created_at.desc' });
      let ocorrencias = [];
      try { ocorrencias = await oc.listByOrder(id); } catch { /* tabela ainda não migrada */ }
      return res.status(200).json({ order, events, history, ocorrencias, emailConfigurado: oc.isConfigured() });
    }
    // ---- filtros server-side (varre o banco inteiro, não só os recentes) ----
    let where = '';
    const conds = [];
    if (status) conds.push(`status=eq.${status}`);
    if (transportadora) conds.push(transportadora === 'local' ? `transportadora=in.(local,motoboy,retirada)` : `transportadora=eq.${transportadora}`);
    if (nf) conds.push(`nota_fiscal=ilike.*${nf}*`);
    if (rastreio) conds.push(`tracking_code=ilike.*${rastreio}*`);
    if (acareacao === 'true') conds.push('acareacao_aberta=eq.true');
    if (ocorrencia === 'true') conds.push('ocorrencia=not.is.null');
    else if (ocorrencia) conds.push(`ocorrencia=eq.${ocorrencia}`);
    if (q) conds.push(`or=(numero.ilike.*${q}*,tracking_code.ilike.*${q}*,nota_fiscal.ilike.*${q}*,cliente_nome.ilike.*${q}*,cliente_email.ilike.*${q}*)`);
    if (conds.length) where = conds.join('&');
    let orders = await sb.select('cmp_orders', { where, order: 'criado_em.desc', limit: 500 });
    // esconde pedidos arquivados das listas (a não ser que peça arquivados=true)
    if (arquivados !== 'true') orders = orders.filter((o) => !(o.raw && o.raw.arquivado));
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
    const { action, id, status, tipo, ocId, texto, notificar } = req.body || {};

    // ---- ações de ocorrência que operam por ocId (não precisam do pedido) ----
    if (action === 'ocorrenciaComentar') { const r = await oc.comentar(ocId, texto); return res.status(200).json({ ok: !!r, ocorrencia: r }); }
    if (action === 'ocorrenciaTratativa') { const r = await oc.tratativa(ocId); return res.status(200).json({ ok: !!r, ocorrencia: r }); }
    if (action === 'ocorrenciaFechar') { const r = await oc.fechar(ocId); return res.status(200).json({ ok: !!r, ocorrencia: r }); }
    if (action === 'ocorrenciaNotificar') { const r = await oc.notificarCliente(ocId); return res.status(200).json({ ok: !!r?.sent, email: r }); }
    if (action === 'ocorrenciaNotifTransp') { const r = await oc.notifTransportadora(ocId); return res.status(200).json({ ok: !!r, ocorrencia: r }); }

    const order = await sb.selectOne('cmp_orders', { where: `id=eq.${id}` });
    if (!order) return res.status(404).json({ error: 'não encontrado' });

    if (action === 'ocorrenciaAbrir') {
      const r = await oc.abrir(order, tipo || 'Problemas diversos', { auto: false, notificar: notificar === true });
      return res.status(200).json({ ok: true, ...r });
    }

    if (action === 'setStatus') {
      const patch = { status, updated_at: new Date().toISOString() };
      if (status === 'entregue') patch.data_entrega = new Date().toISOString();
      else if (order.status === 'entregue') patch.data_entrega = null; // saindo de entregue
      if (status === 'enviado' && !order.data_envio) patch.data_envio = new Date().toISOString();
      await sb.update('cmp_orders', `id=eq.${id}`, patch);
      await sb.insert('cmp_status_history', { order_id: id, from_status: order.status, to_status: status, source: 'manual' }, { returning: false });
      try { await li.updateOrderStatus(order.li_id, status); } catch {}
      return res.status(200).json({ ok: true });
    }
    if (action === 'track') { const r = await processOrder(Number(id)); return res.status(200).json({ ok: true, r }); }
    if (action === 'closeAcareacao') { await sb.update('cmp_orders', `id=eq.${id}`, { acareacao_aberta: false }); return res.status(200).json({ ok: true }); }
    if (action === 'voltarStatus') {
      const hist = await sb.selectOne('cmp_status_history', { where: `order_id=eq.${id}`, order: 'created_at.desc' });
      let prev = hist?.from_status;
      if (!prev) { const ORD = ['criado', 'pago', 'em_separacao', 'faturado', 'enviado', 'entregue']; const i = ORD.indexOf(order.status); prev = i > 0 ? ORD[i - 1] : order.status; }
      const patch = { status: prev, updated_at: new Date().toISOString() };
      if (order.status === 'entregue') patch.data_entrega = null;
      await sb.update('cmp_orders', `id=eq.${id}`, patch);
      await sb.insert('cmp_status_history', { order_id: id, from_status: order.status, to_status: prev, source: 'voltar' }, { returning: false });
      try { await li.updateOrderStatus(order.li_id, prev); } catch {}
      return res.status(200).json({ ok: true, status: prev });
    }
    if (action === 'alterarRastreio') {
      const patch = { tracking_code: (req.body.tracking_code || '').trim() || null, updated_at: new Date().toISOString() };
      if (req.body.transportadora) patch.transportadora = req.body.transportadora;
      await sb.update('cmp_orders', `id=eq.${id}`, patch);
      return res.status(200).json({ ok: true });
    }
    if (action === 'alterarEmail') {
      await sb.update('cmp_orders', `id=eq.${id}`, { cliente_email: (req.body.email || '').trim() || null, updated_at: new Date().toISOString() });
      return res.status(200).json({ ok: true });
    }
    if (action === 'arquivar') {
      await sb.update('cmp_orders', `id=eq.${id}`, { raw: { ...(order.raw || {}), arquivado: true }, updated_at: new Date().toISOString() });
      return res.status(200).json({ ok: true });
    }
    return res.status(400).json({ error: 'ação inválida' });
  }

  res.status(405).json({ error: 'método não suportado' });
}
