// api/li-pedido.js — consulta de UM pedido na Loja Integrada, pelo número.
//
// Serve pra duas coisas:
//  1. o robô saber responder "já bordou?", "já saiu?", "cadê meu pedido?";
//  2. a gente conferir na mão se a consulta está funcionando (?numero=249640).
//
// Só leitura, e só pra quem está logado na suíte (ou pro próprio servidor, com a chave
// de serviço no cabeçalho x-internal — é assim que o chatbot-reply chama).

import { buscarPedidoLI } from '../lib/li-pedido.js';

async function logado(token) {
  if (!token) return false;
  try {
    const r = await fetch(process.env.SUPABASE_URL + '/auth/v1/user', {
      headers: { apikey: process.env.SUPABASE_SERVICE_ROLE_KEY, Authorization: 'Bearer ' + token }
    });
    const j = await r.json();
    return !!(j && j.id);
  } catch (e) { return false; }
}

export default async function handler(req, res) {
  const interno = (req.headers['x-internal'] || '') === process.env.SUPABASE_SERVICE_ROLE_KEY;
  const ok = interno || await logado((req.headers.authorization || '').replace('Bearer ', ''));
  if (!ok) return res.status(401).json({ error: 'precisa estar logado' });

  const numero = (req.query.numero || (req.body && req.body.numero) || '').toString();
  if (!numero) return res.status(400).json({ error: 'informe ?numero=' });

  const r = await buscarPedidoLI(numero);
  if (!r.ok) return res.status(404).json({ error: r.motivo });
  return res.status(200).json({ ok: true, via: r.via, pedido: r.pedido });
}
