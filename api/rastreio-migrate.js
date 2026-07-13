// Ingestão da MIGRAÇÃO: recebe lotes de pedidos exportados do cademeupedido
// e grava em cmp_orders. Protegido por CMP_CRON_SECRET (o script roda no
// navegador, na origem do cademeupedido, e envia os lotes para cá).
import * as sb from '../lib/supabase.js';
import { CMP_STATUS_TO_INTERNAL, carrierKey } from '../lib/statusmap.js';

export const config = { maxDuration: 60 };

function mapOrder(o) {
  const cli = o.client || {};
  const row = {
    li_id: String(o.order_id || o.number || o.id),
    numero: String(o.order_id || o.number || ''),
    nota_fiscal: o.invoice_number || '',
    cliente_nome: cli.name || o.client_name || '',
    cliente_email: (o.email || cli.email || '').toLowerCase(),
    cliente_cpf: (cli.document || '').replace(/\D/g, ''),
    preco: Number(o.price || 0),
    transportadora: carrierKey(o.shipping_company_name || ''),
    servico: o.shipping_company_name || '',
    status: CMP_STATUS_TO_INTERNAL[o.status_id] || 'criado',
    visitas: Number(o.visits_count || 0),
    criado_em: o.created_at || new Date().toISOString(),
    data_envio: o.sent_date || null,
    data_entrega: o.delivery_date || null,
    acareacao_aberta: !!o.occurrence_open_at,
    acareacao_em: o.occurrence_open_at || null,
    skus: Array.isArray(o.products) ? o.products.map((p) => p.sku).filter(Boolean) : [],
    raw: o,
  };
  if (o.store_delivery_deadline_date) row.prazo_entrega = o.store_delivery_deadline_date;
  return row;
}

export default async function handler(req, res) {
  const secret = process.env.CMP_CRON_SECRET;
  const provided = (req.headers.authorization || '').replace('Bearer ', '') || req.query.secret;
  if (secret && provided !== secret) return res.status(401).json({ error: 'não autorizado' });
  if (req.method !== 'POST') return res.status(405).json({ error: 'use POST' });

  const orders = req.body?.orders || [];
  if (!Array.isArray(orders) || !orders.length) return res.status(400).json({ error: 'envie { orders: [...] }' });

  let ok = 0, erros = 0;
  for (const o of orders) {
    try { await sb.upsert('cmp_orders', mapOrder(o), 'li_id'); ok++; }
    catch (e) { erros++; }
  }
  return res.status(200).json({ recebidos: orders.length, gravados: ok, erros });
}
