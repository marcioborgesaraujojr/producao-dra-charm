// Consulta pública do cliente: e-mail/CPF (+ pedido opcional).
// Incrementa "visitas". Não expõe o banco — só devolve o necessário.
import * as sb from '../lib/supabase.js';

export default async function handler(req, res) {
  const doc = (req.query.doc || req.body?.doc || '').toString().trim();
  const pedido = (req.query.pedido || req.body?.pedido || '').toString().trim();
  if (!doc) return res.status(400).json({ error: 'Informe e-mail ou CPF.' });

  const email = doc.toLowerCase();
  const cpf = doc.replace(/\D/g, '');
  const ors = [`cliente_email.eq.${email}`];
  if (cpf.length >= 11) ors.push(`cliente_cpf.eq.${cpf}`);
  let where = `or=(${ors.join(',')})`;
  if (pedido) where += `&numero=eq.${encodeURIComponent(pedido)}`;

  let order;
  try {
    order = await sb.selectOne('cmp_orders', { where, order: 'criado_em.desc' });
  } catch (e) {
    return res.status(500).json({ error: 'Erro ao consultar. Tente novamente.' });
  }
  if (!order) return res.status(404).json({ error: 'Não encontramos um pedido com esses dados.' });

  // conta visita só quando é o CLIENTE (não quando o admin usa "Acompanhar Pedido")
  const isPreview = (req.query.preview || req.body?.preview) === '1';
  if (!isPreview) await sb.update('cmp_orders', `id=eq.${order.id}`, { visitas: (order.visitas || 0) + 1 }).catch(() => {});
  const events = await sb.select('cmp_events', { where: `order_id=eq.${order.id}`, order: 'data.desc' });

  // devolve só campos seguros para o cliente
  return res.status(200).json({
    order: {
      numero: order.numero, status: order.status, transportadora: order.transportadora,
      servico: order.servico, tracking_code: order.tracking_code, destino: order.destino,
      prazo_entrega: order.prazo_entrega, data_envio: order.data_envio, data_entrega: order.data_entrega,
      bordado: (order.raw && order.raw.bordado) || null,
    },
    events: events.map((e) => ({ data: e.data, descricao: e.descricao, local: e.local })),
  });
}
