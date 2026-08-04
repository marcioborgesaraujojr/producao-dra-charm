// api/whatsapp-template-criar.js
// Cria um TEMPLATE novo e envia pra aprovação da Meta (WhatsApp Cloud API).
// A Meta revisa e o status começa em PENDING; quando ela aprova, vira APPROVED e
// aí pode ser enviado pelo botão "Modelos" no atendimento.
//
// Env vars no Vercel:
//   WA_ACCESS_TOKEN, WA_WABA_ID (fallback 579587495233435)
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
//
// POST (Bearer da suíte) body:
//   { name, category, language, body, exemplos:[...], footer? }
//   - name: vira minúsculo com underscore automaticamente
//   - category: MARKETING | UTILITY
//   - body: texto com {{1}}, {{2}}...
//   - exemplos: um valor de exemplo por variável (obrigatório se houver {{n}})

const GRAPH = 'https://graph.facebook.com/v20.0';
const WABA = () => process.env.WA_WABA_ID || '579587495233435';

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

function slug(s) {
  return String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '').replace(/_{2,}/g, '_').slice(0, 60) || ('modelo_' + Date.now());
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'authorization, content-type');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método não permitido' });

  const email = await callerEmail((req.headers.authorization || '').replace('Bearer ', '').trim());
  if (!email) return res.status(403).json({ error: 'Faça login na suíte.' });
  if (!process.env.WA_ACCESS_TOKEN) return res.status(503).json({ error: 'Falta WA_ACCESS_TOKEN no Vercel.' });

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
  body = body || {};

  const name = slug(body.name);
  const category = (body.category === 'UTILITY' ? 'UTILITY' : 'MARKETING');
  const language = body.language || 'pt_BR';
  const texto = String(body.body || '').trim();
  const footer = String(body.footer || '').trim();
  const exemplos = Array.isArray(body.exemplos) ? body.exemplos.map(x => String(x || '')) : [];

  if (!texto) return res.status(400).json({ error: 'Escreva o corpo do modelo.' });

  // quantas variáveis {{n}} tem no corpo
  const nVars = (texto.match(/\{\{\s*\d+\s*\}\}/g) || []).length;
  if (nVars > 0 && exemplos.filter(Boolean).length < nVars) {
    return res.status(400).json({ error: 'Preencha um exemplo para cada variável {{n}} (a Meta exige pra aprovar).' });
  }

  const componentes = [];
  const bodyComp = { type: 'BODY', text: texto };
  if (nVars > 0) bodyComp.example = { body_text: [exemplos.slice(0, nVars)] };
  componentes.push(bodyComp);
  if (footer) componentes.push({ type: 'FOOTER', text: footer.slice(0, 60) });

  try {
    const r = await fetch(GRAPH + '/' + WABA() + '/message_templates', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + process.env.WA_ACCESS_TOKEN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, language, category, components: componentes })
    });
    const j = await r.json();
    if (!r.ok) return res.status(r.status).json({ error: (j.error && j.error.message) || 'A Meta recusou o modelo.', detalhe: j });
    return res.status(200).json({ ok: true, name, status: j.status || 'PENDING', id: j.id || null });
  } catch (e) { return res.status(500).json({ error: e.message }); }
}
