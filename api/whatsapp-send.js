// api/whatsapp-send.js
// Envio de mensagem pelo WhatsApp Cloud API (oficial) e gravação em at_mensagens.
// Chamado pelo front (atendimento.html) com o token de sessão do atendente.
//
// Env vars no Vercel (o Marcio cadastra; NUNCA no código):
//   WA_ACCESS_TOKEN            (token permanente do WhatsApp Business)
//   WA_PHONE_NUMBER_ID         (Phone Number ID do número que envia)
//   SUPABASE_URL               (já existe)
//   SUPABASE_SERVICE_ROLE_KEY  (já existe)
//
// Body esperado: { to: "5585999999999", text: "mensagem", conversa_id: "<uuid>" }
// Observação sobre a janela de 24h: fora da janela, o WhatsApp exige TEMPLATE aprovado.
// Este endpoint envia texto livre (dentro da janela). Envio de template fica pra próxima etapa.

const GRAPH = 'https://graph.facebook.com/v20.0';

// Brasil / 9º dígito: o webhook do WhatsApp às vezes devolve o wa_id SEM o 9
// (ex.: 558588736100). A API aceita e devolve um ID de mensagem, mas NÃO entrega.
// Pra entregar de verdade o número de celular precisa dos 13 dígitos: 55 + DDD(2) + 9 + 8.
// Se vier com 12 dígitos (55 + DDD + 8, sem o 9), a gente insere o 9 depois do DDD.
function normalizeWa(raw) {
  let n = String(raw || '').replace(/\D/g, '');
  if (n.startsWith('55') && n.length === 12) {
    n = '55' + n.slice(2, 4) + '9' + n.slice(4);
  }
  return n;
}

async function sbInsertMsg(conversaId, texto, autor) {
  await fetch(process.env.SUPABASE_URL + '/rest/v1/at_mensagens', {
    method: 'POST',
    headers: {
      apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: 'Bearer ' + process.env.SUPABASE_SERVICE_ROLE_KEY,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ conversa_id: conversaId, direcao: 'out', tipo: 'texto', conteudo: texto, autor: autor || 'atendente' })
  });
  await fetch(process.env.SUPABASE_URL + '/rest/v1/at_conversas?id=eq.' + conversaId, {
    method: 'PATCH',
    headers: {
      apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: 'Bearer ' + process.env.SUPABASE_SERVICE_ROLE_KEY,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ ultima_msg_preview: String(texto).slice(0, 120), ultima_msg_em: new Date().toISOString(), modo: 'humano' })
  });
}

// valida o atendente pelo token de sessão (não deixa qualquer um enviar)
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

// ESCUDO ANTIBANIMENTOS (fail-open): só BLOQUEIA se a qualidade estiver CONFIRMADAMENTE
// ruim E o toggle correspondente estiver ligado. Qualquer dúvida/erro/desconhecido -> LIBERA.
// Assim o envio nunca quebra por causa do escudo; ele só age no caso crítico de verdade.
async function escudoBloqueia() {
  try {
    const r = await fetch(process.env.SUPABASE_URL + '/rest/v1/wa_saude?id=eq.1&select=quality_rating,auto_moderado,auto_ruim', {
      headers: { apikey: process.env.SUPABASE_SERVICE_ROLE_KEY, Authorization: 'Bearer ' + process.env.SUPABASE_SERVICE_ROLE_KEY }
    });
    if (!r.ok) return null;
    const rows = await r.json();
    const s = Array.isArray(rows) && rows.length ? rows[0] : null;
    if (!s) return null;
    const q = String(s.quality_rating || '').toUpperCase();
    if (s.auto_ruim && q === 'RED') return 'RED';
    if (s.auto_moderado && q === 'YELLOW') return 'YELLOW';
    return null;
  } catch (e) { return null; }
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
    return res.status(503).json({ error: 'WhatsApp ainda não configurado (faltam WA_ACCESS_TOKEN / WA_PHONE_NUMBER_ID no Vercel).' });
  }

  // Escudo antibanimentos: se ligado e a qualidade estiver crítica, segura o envio.
  const bloq = await escudoBloqueia();
  if (bloq) {
    return res.status(423).json({
      escudo: bloq,
      error: bloq === 'RED'
        ? 'Escudo antibanimentos: envios pausados — a qualidade do número está "Ruim" (crítica). Ajuste no Escudo antibanimentos.'
        : 'Escudo antibanimentos: envios pausados — a qualidade do número está em nível médio. Ajuste no Escudo antibanimentos.'
    });
  }

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
  const to = body && body.to;
  const text = body && body.text;
  const conversaId = body && body.conversa_id;
  if (!to || !text) return res.status(400).json({ error: 'Campos "to" e "text" são obrigatórios.' });

  const toNorm = normalizeWa(to);
  const r = await fetch(GRAPH + '/' + process.env.WA_PHONE_NUMBER_ID + '/messages', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + process.env.WA_ACCESS_TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', to: toNorm, type: 'text', text: { body: String(text) } })
  });
  let j = null; try { j = await r.json(); } catch (e) {}
  if (!r.ok) {
    return res.status(400).json({ error: (j && j.error && j.error.message) || 'Falha ao enviar', detalhe: j });
  }
  if (conversaId) { try { await sbInsertMsg(conversaId, text, email); } catch (e) {} }
  // "para" = número normalizado usado no envio; "contatos" = wa_id que a Meta resolveu (útil pra depurar entrega).
  return res.status(200).json({ ok: true, id: j?.messages?.[0]?.id || null, para: toNorm, contatos: j?.contacts || null });
}
