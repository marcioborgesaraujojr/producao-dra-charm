// api/foto-cliente.js
// Foto de perfil do cliente (WhatsApp) via serviço de terceiro. Usa lib/foto.js.
// - Preenche automático quando o cliente manda mensagem (isso é feito no whatsapp-webhook.js).
// - Aqui: busca sob demanda (teste) e BACKFILL dos clientes que já existem.
//
// GET  ?config=1        (Bearer suíte) -> { configurado }
// GET  ?wa=NUMERO       (Bearer suíte) -> { url }            (teste rápido de um número)
// POST {action:'backfill', limit}  (Bearer suíte) -> busca foto pra N clientes sem foto

import { buscarFotoWhatsApp } from '../lib/foto.js';

const SB  = () => process.env.SUPABASE_URL;
const KEY = () => process.env.SUPABASE_SERVICE_ROLE_KEY;

async function sb(path, opts = {}) {
  const r = await fetch(SB() + '/rest/v1/' + path, {
    ...opts,
    headers: { apikey: KEY(), Authorization: 'Bearer ' + KEY(), 'Content-Type': 'application/json', ...(opts.headers || {}) }
  });
  const txt = await r.text();
  let data = null; try { data = txt ? JSON.parse(txt) : null; } catch (e) { data = txt; }
  return { ok: r.ok, status: r.status, data };
}

async function callerEmail(token) {
  if (!token) return null;
  try {
    const r = await fetch(SB() + '/auth/v1/user', { headers: { apikey: KEY(), Authorization: 'Bearer ' + token } });
    const j = await r.json();
    return j && j.email ? String(j.email) : null;
  } catch (e) { return null; }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'authorization, content-type');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const email = await callerEmail((req.headers.authorization || '').replace('Bearer ', '').trim());
  if (!email) return res.status(403).json({ error: 'Faça login na suíte.' });

  const q = req.query || {};

  if (req.method === 'GET') {
    if (q.config) return res.status(200).json({ configurado: !!process.env.FOTO_API_URL });
    if (q.wa) {
      if (!process.env.FOTO_API_URL) return res.status(503).json({ error: 'Serviço de foto não configurado (FOTO_API_URL no Vercel).' });
      // modo debug: mostra a resposta crua do serviço (cache=true e cache=false) pra afinar o parser
      if (q.debug) {
        const n = String(q.wa).replace(/\D/g, '');
        const base = process.env.FOTO_API_URL;
        const mk = (extra) => base.includes('{PHONE}') ? base.replace(/\{PHONE\}/g, encodeURIComponent(n)) + extra : (base + (base.includes('?') ? '&' : '?') + 'phoneNumber=' + encodeURIComponent(n) + extra);
        const H = {};
        if (process.env.FOTO_API_KEY) H['X-RapidAPI-Key'] = process.env.FOTO_API_KEY;
        if (process.env.FOTO_API_HOST) H['X-RapidAPI-Host'] = process.env.FOTO_API_HOST;
        const out = {};
        for (const [label, u] of [['configurada', mk('')], ['cacheFalse', mk('').replace('cache=true', 'cache=false')]]) {
          try { const r = await fetch(u, { headers: H }); const t = await r.text(); out[label] = { status: r.status, ct: r.headers.get('content-type'), body: t.slice(0, 500) }; }
          catch (e) { out[label] = { erro: e.message }; }
        }
        return res.status(200).json(out);
      }
      const url = await buscarFotoWhatsApp(q.wa);
      return res.status(200).json({ url: url || null });
    }
    return res.status(400).json({ error: 'Use ?config=1 ou ?wa=NUMERO' });
  }

  if (req.method !== 'POST') return res.status(405).json({ error: 'Método não permitido' });
  if (!process.env.FOTO_API_URL) return res.status(503).json({ error: 'Serviço de foto não configurado (FOTO_API_URL no Vercel).' });

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
  body = body || {};

  if (body.action === 'backfill') {
    const limit = Math.min(Math.max(parseInt(body.limit || 25, 10) || 25, 1), 100);
    const corte = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();
    // clientes com número, sem foto, e que não foram checados nos últimos 7 dias
    const rr = await sb('at_clientes?select=id,whatsapp_id,telefone,foto_url,foto_checked_at&foto_url=is.null&or=(foto_checked_at.is.null,foto_checked_at.lt.' + encodeURIComponent(corte) + ')&limit=' + limit);
    const lista = Array.isArray(rr.data) ? rr.data : [];
    let encontrados = 0;
    for (const cli of lista) {
      const num = cli.whatsapp_id || cli.telefone;
      let url = null;
      if (num) { try { url = await buscarFotoWhatsApp(num); } catch (e) {} }
      await sb('at_clientes?id=eq.' + cli.id, { method: 'PATCH', body: JSON.stringify({ foto_url: url || null, foto_checked_at: new Date().toISOString() }) });
      if (url) encontrados++;
    }
    return res.status(200).json({ ok: true, processados: lista.length, encontrados });
  }

  return res.status(400).json({ error: 'ação desconhecida' });
}
