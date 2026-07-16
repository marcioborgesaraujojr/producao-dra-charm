// api/chatbot-reply.js
// Cérebro do chatbot de IA — AGNÓSTICO: funciona com OpenAI (GPT) ou Anthropic (Claude).
// Escolhe o provedor pela chave que estiver no Vercel e pelo modelo configurado.
//
// Env no Vercel (basta UMA das chaves):
//   OPENAI_API_KEY       -> usa GPT (ex.: gpt-4o-mini)  [mais fácil/barato]
//   ANTHROPIC_API_KEY    -> usa Claude (ex.: claude-haiku)
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY  (já existem)
//
// Body: { mensagens: [{role:'user'|'assistant', content:'...'}], conversa_id? }
// Retorno: { reply, handoff:boolean }

async function callerEmail(token) {
  if (!token) return null;
  try {
    const r = await fetch(process.env.SUPABASE_URL + '/auth/v1/user', {
      headers: { apikey: process.env.SUPABASE_SERVICE_ROLE_KEY, Authorization: 'Bearer ' + token }
    });
    const j = await r.json(); return j && j.email ? String(j.email) : null;
  } catch (e) { return null; }
}
async function getConfig() {
  const r = await fetch(process.env.SUPABASE_URL + '/rest/v1/at_chatbot?id=eq.1&select=*', {
    headers: { apikey: process.env.SUPABASE_SERVICE_ROLE_KEY, Authorization: 'Bearer ' + process.env.SUPABASE_SERVICE_ROLE_KEY }
  });
  const j = await r.json(); return Array.isArray(j) && j[0] ? j[0] : {};
}
function montarSystem(cfg) {
  let s = cfg.persona || 'Você é uma atendente virtual simpática e objetiva. Responda em português do Brasil.';
  if (cfg.base_conhecimento && cfg.base_conhecimento.trim())
    s += '\n\nBase de conhecimento (use quando útil):\n' + cfg.base_conhecimento;
  s += '\n\nRegras: seja breve (1 a 4 frases). Se o cliente pedir para falar com humano, reclamar formalmente, ou pedir algo que exija um atendente, responda educadamente que vai transferir para um atendente humano.';
  return s;
}

async function viaOpenAI(cfg, mensagens) {
  const r = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + process.env.OPENAI_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: cfg.modelo || 'gpt-4o-mini',
      messages: [{ role: 'system', content: montarSystem(cfg) }, ...mensagens],
      temperature: 0.5, max_tokens: 400
    })
  });
  const j = await r.json();
  if (!r.ok) throw new Error((j.error && j.error.message) || 'Erro OpenAI');
  return j.choices?.[0]?.message?.content || '';
}
async function viaAnthropic(cfg, mensagens) {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: cfg.modelo && cfg.modelo.startsWith('claude') ? cfg.modelo : 'claude-haiku-4-5-20251001',
      system: montarSystem(cfg), max_tokens: 400,
      messages: mensagens.map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content }))
    })
  });
  const j = await r.json();
  if (!r.ok) throw new Error((j.error && j.error.message) || 'Erro Anthropic');
  return (j.content && j.content[0] && j.content[0].text) || '';
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

  let body = req.body; if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
  const mensagens = Array.isArray(body.mensagens) ? body.mensagens.slice(-12) : [];
  if (!mensagens.length) return res.status(400).json({ error: 'Envie "mensagens".' });

  const cfg = await getConfig();
  const usaClaude = (cfg.modelo || '').startsWith('claude');
  const temOpenAI = !!process.env.OPENAI_API_KEY;
  const temAnthropic = !!process.env.ANTHROPIC_API_KEY;

  try {
    let reply;
    if (usaClaude && temAnthropic) reply = await viaAnthropic(cfg, mensagens);
    else if (temOpenAI) reply = await viaOpenAI(cfg, mensagens);
    else if (temAnthropic) reply = await viaAnthropic(cfg, mensagens);
    else return res.status(503).json({ error: 'Chatbot não configurado: falta OPENAI_API_KEY ou ANTHROPIC_API_KEY no Vercel.' });

    const termos = (cfg.handoff_termos || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
    const ultima = (mensagens[mensagens.length - 1].content || '').toLowerCase();
    const handoff = termos.some(t => t && ultima.includes(t));
    return res.status(200).json({ reply, handoff });
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
}
