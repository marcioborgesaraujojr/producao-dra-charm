// api/whatsapp-send-media.js
// Envia uma FOTO (imagem) pelo WhatsApp Cloud API e grava em at_mensagens.
// O front sobe a imagem no bucket público "at-media" e manda a URL pra cá.
//
// Body: { to, conversa_id, midia_url, text? }
// Env: WA_ACCESS_TOKEN, WA_PHONE_NUMBER_ID, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

const GRAPH = 'https://graph.facebook.com/v20.0';

function normalizeWa(raw) {
  let n = String(raw || '').replace(/\D/g, '');
  if (n.startsWith('55') && n.length === 12) { n = '55' + n.slice(2, 4) + '9' + n.slice(4); }
  return n;
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

// A bolha da conversa mostra quem respondeu. Guardar o e-mail aqui fazia a atendente
// ver "fulana@gmail.com" em cima de cada mensagem. Aqui a gente troca pelo nome do
// perfil ANTES de gravar. Sem perfil/nome, arruma o começo do e-mail (ana.paula -> Ana Paula).
function _capitalizaNome(s) {
  return String(s || '').split(/[\s._-]+/).filter(Boolean)
    .map(function (p) { return p.charAt(0).toUpperCase() + p.slice(1); }).join(' ');
}
async function nomeDoAtendente(email) {
  const e = String(email || '').trim();
  if (!e) return null;
  try {
    const r = await fetch(process.env.SUPABASE_URL + '/rest/v1/profiles?select=full_name&email=eq.'
      + encodeURIComponent(e) + '&limit=1', {
      headers: { apikey: process.env.SUPABASE_SERVICE_ROLE_KEY, Authorization: 'Bearer ' + process.env.SUPABASE_SERVICE_ROLE_KEY }
    });
    const j = await r.json();
    const nome = Array.isArray(j) && j[0] && j[0].full_name ? String(j[0].full_name).trim() : '';
    if (nome && nome.indexOf('@') === -1) return nome;
  } catch (err) { /* nome é enfeite: nunca pode derrubar o envio */ }
  return _capitalizaNome(e.split('@')[0]) || null;
}

async function sbInsertMsg(conversaId, midiaUrl, caption, autor) {
  await fetch(process.env.SUPABASE_URL + '/rest/v1/at_mensagens', {
    method: 'POST',
    headers: {
      apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: 'Bearer ' + process.env.SUPABASE_SERVICE_ROLE_KEY,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ conversa_id: conversaId, direcao: 'out', tipo: 'imagem', conteudo: caption || '[imagem]', midia_url: midiaUrl, midia_tipo: 'imagem', autor: autor || 'atendente' })
  });
  await fetch(process.env.SUPABASE_URL + '/rest/v1/at_conversas?id=eq.' + conversaId, {
    method: 'PATCH',
    headers: {
      apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: 'Bearer ' + process.env.SUPABASE_SERVICE_ROLE_KEY,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ ultima_msg_preview: caption ? String(caption).slice(0, 120) : '📷 Foto', ultima_msg_em: new Date().toISOString(), modo: 'humano' })
  });
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'authorization, content-type');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método não permitido' });

  const token = (req.headers.authorization || '').replace('Bearer ', '').trim();
  const email = await callerEmail(token);
  if (!email) return res.status(403).json({ error: 'Sessão inválida. Faça login na suíte.' });

  if (!process.env.WA_ACCESS_TOKEN || !process.env.WA_PHONE_NUMBER_ID) {
    return res.status(503).json({ error: 'WhatsApp ainda não configurado (faltam WA_ACCESS_TOKEN / WA_PHONE_NUMBER_ID).' });
  }

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
  const to = body && body.to;
  const midiaUrl = body && body.midia_url;
  const caption = (body && body.text) || '';
  const conversaId = body && body.conversa_id;
  if (!to || !midiaUrl) return res.status(400).json({ error: 'Campos "to" e "midia_url" são obrigatórios.' });

  const toNorm = normalizeWa(to);
  const payload = { messaging_product: 'whatsapp', to: toNorm, type: 'image', image: caption ? { link: midiaUrl, caption: String(caption) } : { link: midiaUrl } };
  const r = await fetch(GRAPH + '/' + process.env.WA_PHONE_NUMBER_ID + '/messages', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + process.env.WA_ACCESS_TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  let j = null; try { j = await r.json(); } catch (e) {}
  if (!r.ok) {
    return res.status(400).json({ error: (j && j.error && j.error.message) || 'Falha ao enviar a foto', detalhe: j });
  }
  if (conversaId) { try { await sbInsertMsg(conversaId, midiaUrl, caption, await nomeDoAtendente(email)); } catch (e) {} }
  return res.status(200).json({ ok: true, id: j && j.messages && j.messages[0] && j.messages[0].id || null });
}
