// api/integracoes-config.js — Gravar/gerir credenciais de integração (SÓ ADMIN).
// Hoje: trocar as chaves da Loja Integrada (grava no Edge Config, que os syncs leem
// com fallback pro env). Nunca retorna as chaves — só confirma o resultado.
// O Bling reconecta pelo fluxo OAuth em /api/setup (não passa por aqui).

const SB_URL = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ADMIN_EMAIL = 'marcioborgesaraujojr@gmail.com';

async function validUser(token) {
  if (!token) return null;
  try {
    const r = await fetch(SB_URL + '/auth/v1/user', { headers: { apikey: SB_KEY, Authorization: 'Bearer ' + token } });
    const j = await r.json();
    return (j && j.id) ? j : null;
  } catch (e) { return null; }
}

function parseEC() {
  try {
    const u = new URL(process.env.EDGE_CONFIG || '');
    const ecId = u.pathname.replace(/^\//, '');
    const token = u.searchParams.get('token');
    return ecId && token ? { ecId, token } : null;
  } catch (_) { return null; }
}

async function edgeUpsert(pairs) {
  const ec = parseEC();
  if (!ec || !process.env.VERCEL_TOKEN) return { ok: false, motivo: 'Edge Config / VERCEL_TOKEN indisponível no servidor.' };
  const items = Object.keys(pairs).map((k) => ({ operation: 'upsert', key: k, value: pairs[k] }));
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch('https://api.vercel.com/v1/edge-config/' + ec.ecId + '/items', {
        method: 'PATCH',
        headers: { Authorization: 'Bearer ' + process.env.VERCEL_TOKEN, 'Content-Type': 'application/json' },
        body: JSON.stringify({ items }),
      });
      if (r.ok) return { ok: true };
      if (i === 2) { const t = await r.text().catch(() => ''); return { ok: false, motivo: 'Vercel ' + r.status + ' ' + t.slice(0, 160) }; }
    } catch (e) { if (i === 2) return { ok: false, motivo: e.message }; }
    await new Promise((res) => setTimeout(res, 250));
  }
  return { ok: false, motivo: 'Falha ao gravar.' };
}

// Testa READ-ONLY as chaves antes de gravar (não escreve nada na LI).
async function testarLI(api, app) {
  try {
    const base = process.env.LI_BASE_URL || 'https://api.awsli.com.br/v1';
    const u = new URL(base.replace(/\/$/, '') + '/pedido/');
    u.searchParams.set('chave_api', api);
    u.searchParams.set('chave_aplicacao', app);
    u.searchParams.set('limit', '1');
    const c = new AbortController(); const t = setTimeout(() => c.abort(), 8000);
    let r;
    try { r = await fetch(u.toString(), { headers: { Accept: 'application/json' }, signal: c.signal }); } finally { clearTimeout(t); }
    if (r.ok) return { ok: true };
    if (r.status === 401 || r.status === 403) return { ok: false, motivo: 'Chaves rejeitadas pela Loja Integrada (' + r.status + ').' };
    return { ok: false, motivo: 'Loja Integrada respondeu ' + r.status + '.' };
  } catch (e) { return { ok: false, motivo: 'Não deu pra validar as chaves agora (' + e.message + ').' }; }
}

// Testa a chave da Anthropic com uma chamada mínima (max_tokens:1). Não guarda nada.
async function testarAnthropic(key) {
  try {
    const c = new AbortController(); const t = setTimeout(() => c.abort(), 10000);
    let r;
    try {
      r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        body: JSON.stringify({ model: process.env.ANTHROPIC_MODEL || 'claude-opus-4-8', max_tokens: 1, messages: [{ role: 'user', content: 'oi' }] }),
        signal: c.signal,
      });
    } finally { clearTimeout(t); }
    if (r.ok) return { ok: true };
    let msg = 'Anthropic respondeu ' + r.status + '.';
    if (r.status === 401) msg = 'Chave rejeitada pela Anthropic (401). Confira se copiou certo.';
    else { try { const j = await r.json(); if (j && j.error && j.error.message) msg = 'Anthropic: ' + j.error.message.slice(0, 140); } catch (_) {} }
    return { ok: false, motivo: msg };
  } catch (e) { return { ok: false, motivo: 'Não deu pra validar a chave agora (' + e.message + ').' }; }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'authorization, content-type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'use POST' });

  const token = (req.headers.authorization || '').replace('Bearer ', '');
  const user = await validUser(token);
  if (!user) return res.status(401).json({ error: 'precisa estar logado' });
  if ((user.email || '').toLowerCase() !== ADMIN_EMAIL) return res.status(403).json({ error: 'só o admin' });

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (_) { body = {}; } }
  body = body || {};
  const acao = body.acao;

  if (acao === 'set_anthropic') {
    const key = (body.api_key || '').trim();
    if (!key) return res.status(400).json({ error: 'Cole a chave da Anthropic.' });
    if (!/^sk-ant-/.test(key)) return res.status(400).json({ error: 'Isso não parece uma chave da Anthropic (começa com sk-ant-).' });
    const teste = await testarAnthropic(key);
    if (!teste.ok) return res.status(400).json({ error: teste.motivo });
    const grav = await edgeUpsert({ anthropic_api_key: key });
    if (!grav.ok) return res.status(500).json({ error: 'Chave válida, mas falhou ao salvar: ' + grav.motivo });
    return res.status(200).json({ ok: true, msg: 'Chave da Anthropic validada e salva. O Assistente IA já está ativo (pode levar até 1 min).' });
  }

  if (acao === 'set_li') {
    const api = (body.chave_api || '').trim();
    const app = (body.chave_aplicacao || '').trim();
    if (!api || !app) return res.status(400).json({ error: 'Informe chave_api e chave_aplicacao.' });
    const teste = await testarLI(api, app);
    if (!teste.ok) return res.status(400).json({ error: teste.motivo });
    const grav = await edgeUpsert({ li_chave_api: api, li_chave_aplicacao: app });
    if (!grav.ok) return res.status(500).json({ error: 'Chaves válidas, mas falhou ao salvar: ' + grav.motivo });
    return res.status(200).json({ ok: true, msg: 'Chaves da Loja Integrada validadas e salvas. Pode levar até 1 min pra valer em tudo.' });
  }

  return res.status(400).json({ error: 'ação desconhecida' });
}
