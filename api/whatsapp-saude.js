// api/whatsapp-saude.js
// "Escudo antibanimentos" — saúde do número oficial.
// Consulta a classificação de qualidade (quality_rating) e o tier de mensagens direto
// na Graph API da Meta (funciona hoje, sem depender de assinar webhook novo) e guarda o
// estado em wa_saude. Também salva os toggles de autoproteção (Moderado/Ruim/Opt-out).
//
// Env vars no Vercel (o Marcio cadastra; NUNCA no código):
//   WA_ACCESS_TOKEN, WA_PHONE_NUMBER_ID (já existem)
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (já existem)
//
// GET  (Bearer da suíte) -> { quality, limit, name_status, verified_name, auto_moderado, auto_ruim, optout_auto, checado_em }
// POST (Bearer da suíte) { auto_moderado, auto_ruim, optout_auto } -> salva os toggles

const GRAPH = 'https://graph.facebook.com/v20.0';

async function sb(path, opts = {}) {
  const r = await fetch(process.env.SUPABASE_URL + '/rest/v1/' + path, {
    ...opts,
    headers: {
      apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: 'Bearer ' + process.env.SUPABASE_SERVICE_ROLE_KEY,
      'Content-Type': 'application/json',
      ...(opts.headers || {})
    }
  });
  const txt = await r.text();
  let data = null; try { data = txt ? JSON.parse(txt) : null; } catch (e) { data = txt; }
  return { ok: r.ok, status: r.status, data };
}

async function callerEmail(token) {
  if (!token) return null;
  try {
    const r = await fetch(process.env.SUPABASE_URL + '/auth/v1/user', {
      headers: { apikey: process.env.SUPABASE_SERVICE_ROLE_KEY, Authorization: 'Bearer ' + token }
    });
    const j = await r.json();
    return j && j.email ? String(j.email) : null;
  } catch (e) { return null; }
}

async function lerEstado() {
  const r = await sb('wa_saude?id=eq.1&select=*');
  if (r.ok && Array.isArray(r.data) && r.data.length) return r.data[0];
  return null;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'authorization, content-type');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const email = await callerEmail((req.headers.authorization || '').replace('Bearer ', '').trim());
  if (!email) return res.status(403).json({ error: 'Faça login na suíte.' });

  // ===== salvar toggles =====
  if (req.method === 'POST') {
    let body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
    body = body || {};
    const patch = { atualizado_em: new Date().toISOString() };
    if (typeof body.auto_moderado === 'boolean') patch.auto_moderado = body.auto_moderado;
    if (typeof body.auto_ruim === 'boolean') patch.auto_ruim = body.auto_ruim;
    if (typeof body.optout_auto === 'boolean') patch.optout_auto = body.optout_auto;
    const up = await sb('wa_saude?id=eq.1', { method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify(patch) });
    if (!up.ok) return res.status(500).json({ error: 'Não consegui salvar (a tabela wa_saude existe?).', detalhe: up.data });
    const row = Array.isArray(up.data) ? up.data[0] : up.data;
    return res.status(200).json({ ok: true, auto_moderado: !!(row && row.auto_moderado), auto_ruim: !!(row && row.auto_ruim), optout_auto: !!(row && row.optout_auto) });
  }

  if (req.method !== 'GET') return res.status(405).json({ error: 'Método não permitido' });

  const estado = await lerEstado();
  const toggles = {
    auto_moderado: !!(estado && estado.auto_moderado),
    auto_ruim: estado ? !!estado.auto_ruim : true,   // padrão recomendado: suspender no crítico
    optout_auto: !!(estado && estado.optout_auto)
  };

  // consulta a qualidade ao vivo na Meta
  let quality = 'UNKNOWN', limit = null, name_status = null, verified_name = null, erro = null;
  if (process.env.WA_ACCESS_TOKEN && process.env.WA_PHONE_NUMBER_ID) {
    try {
      const url = GRAPH + '/' + process.env.WA_PHONE_NUMBER_ID +
        '?fields=quality_rating,messaging_limit_tier,verified_name,name_status,code_verification_status' +
        '&access_token=' + encodeURIComponent(process.env.WA_ACCESS_TOKEN);
      const r = await fetch(url);
      const j = await r.json();
      if (r.ok) {
        quality = (j.quality_rating || 'UNKNOWN').toUpperCase();
        limit = j.messaging_limit_tier || null;
        name_status = j.name_status || null;
        verified_name = j.verified_name || null;
      } else {
        erro = (j.error && j.error.message) || 'Erro ao consultar a Meta';
      }
    } catch (e) { erro = e.message; }
  } else {
    erro = 'WhatsApp não configurado (WA_ACCESS_TOKEN / WA_PHONE_NUMBER_ID).';
  }

  // grava o estado (upsert id=1) sem derrubar os toggles
  try {
    await sb('wa_saude?on_conflict=id', {
      method: 'POST',
      headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify([{ id: 1, quality_rating: quality, messaging_limit: limit, name_status, verified_name, checado_em: new Date().toISOString(), atualizado_em: new Date().toISOString() }])
    });
  } catch (e) { /* silencioso */ }

  return res.status(200).json({
    ok: true, quality, limit, name_status, verified_name, erro,
    ...toggles,
    checado_em: new Date().toISOString()
  });
}
