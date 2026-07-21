// api/integracoes-status.js — Status (SÓ LEITURA) das integrações do sistema.
// Nunca retorna segredos: só se está configurado, um indicador de saúde e um "final" mascarado.
// Só admin acessa. O check do Bling NÃO faz refresh (evita rotacionar/quebrar o token).

const SB_URL = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ADMIN_EMAIL = 'marcioborgesaraujojr@gmail.com';

async function validUser(token) {
  if (!token) return null;
  try { const r = await fetch(SB_URL + '/auth/v1/user', { headers: { apikey: SB_KEY, Authorization: 'Bearer ' + token } }); const j = await r.json(); return (j && j.id) ? j : null; } catch (e) { return null; }
}
const fim4 = (v) => v ? ('••••' + String(v).slice(-4)) : null;
function parseEC() { try { const u = new URL(process.env.EDGE_CONFIG || ''); const ecId = u.pathname.replace(/^\//, ''); const token = u.searchParams.get('token'); return ecId && token ? { ecId, token } : null; } catch (_) { return null; } }
async function fetchTimeout(url, opts, ms) { const c = new AbortController(); const t = setTimeout(() => c.abort(), ms || 6000); try { return await fetch(url, { ...opts, signal: c.signal }); } finally { clearTimeout(t); } }

async function statusBling() {
  const has = !!(process.env.BLING_CLIENT_ID && process.env.BLING_CLIENT_SECRET);
  let temRefresh = !!process.env.BLING_REFRESH_TOKEN;
  let cacheAte = null;
  const ec = parseEC();
  if (ec) {
    try { const r = await fetchTimeout('https://edge-config.vercel.com/' + ec.ecId + '/item/bling_refresh_token?token=' + ec.token, {}, 5000); if (r.ok) { const v = await r.json(); if (v) temRefresh = true; } } catch (_) {}
    try { const r = await fetchTimeout('https://edge-config.vercel.com/' + ec.ecId + '/item/bling_access_cache?token=' + ec.token, {}, 5000); if (r.ok) { const v = await r.json(); const o = typeof v === 'string' ? JSON.parse(v) : v; if (o && o.expires) cacheAte = o.expires; } } catch (_) {}
  }
  if (!has || !temRefresh) return { nome: 'Bling (estoque)', tipo: 'OAuth', configurado: false, status: 'nao_configurado', detalhe: 'Sem credenciais/refresh token. Reconecte em /api/setup.' };
  const valido = cacheAte && cacheAte > Date.now();
  return {
    nome: 'Bling (estoque)', tipo: 'OAuth', configurado: true,
    status: valido ? 'conectado' : 'configurado',
    detalhe: valido ? ('Token em cache válido até ' + new Date(cacheAte).toLocaleString('pt-BR')) : 'Conectado — renova o token no próximo uso.',
    hint: 'client ' + fim4(process.env.BLING_CLIENT_ID)
  };
}

async function statusLI() {
  const api = process.env.LI_CHAVE_API, app = process.env.LI_CHAVE_APLICACAO;
  if (!api || !app) return { nome: 'Loja Integrada', tipo: 'Chave de API', configurado: false, status: 'nao_configurado', detalhe: 'Faltam LI_CHAVE_API / LI_CHAVE_APLICACAO.' };
  const base = process.env.LI_BASE_URL || 'https://api.awsli.com.br/v1';
  let status = 'configurado', detalhe = 'Chaves presentes.';
  try {
    const u = new URL(base.replace(/\/$/, '') + '/pedido/'); u.searchParams.set('chave_api', api); u.searchParams.set('chave_aplicacao', app); u.searchParams.set('limit', '1');
    const r = await fetchTimeout(u.toString(), {}, 6000);
    if (r.ok) { status = 'conectado'; detalhe = 'Conexão OK (respondendo).'; }
    else if (r.status === 401 || r.status === 403) { status = 'erro'; detalhe = 'Chave rejeitada (' + r.status + ').'; }
    else { status = 'configurado'; detalhe = 'Configurada (retornou ' + r.status + ').'; }
  } catch (e) { status = 'configurado'; detalhe = 'Configurada (não deu pra confirmar agora).'; }
  return { nome: 'Loja Integrada', tipo: 'Chave de API', configurado: true, status, detalhe, hint: 'chave ' + fim4(api) };
}

function presenca(nome, tipo, cond, faltas, hint) {
  return cond
    ? { nome, tipo, configurado: true, status: 'configurado', detalhe: 'Credenciais presentes.', hint: hint || null }
    : { nome, tipo, configurado: false, status: 'nao_configurado', detalhe: 'Faltando: ' + faltas };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  const user = await validUser(token);
  if (!user) return res.status(401).json({ error: 'precisa estar logado' });
  if ((user.email || '').toLowerCase() !== ADMIN_EMAIL) return res.status(403).json({ error: 'só o admin' });

  try {
    const [bling, li] = await Promise.all([statusBling(), statusLI()]);
    const integracoes = [
      bling,
      li,
      presenca('Correios (rastreio)', 'Usuário/Senha CWS', !!(process.env.CORREIOS_CWS_USUARIO && process.env.CORREIOS_CWS_SENHA), 'usuário/senha CWS', process.env.CORREIOS_CARTAO_POSTAGEM ? ('cartão ' + fim4(process.env.CORREIOS_CARTAO_POSTAGEM)) : null),
      presenca('WhatsApp (mensagens)', 'API oficial', !!(process.env.WA_ACCESS_TOKEN && process.env.WA_PHONE_NUMBER_ID), 'token/phone id', process.env.WA_PHONE_NUMBER_ID ? ('phone ' + fim4(process.env.WA_PHONE_NUMBER_ID)) : null),
      presenca('Claude / Anthropic (Assistente IA)', 'Chave de API', !!process.env.ANTHROPIC_API_KEY, 'ANTHROPIC_API_KEY', process.env.ANTHROPIC_API_KEY ? fim4(process.env.ANTHROPIC_API_KEY) : null),
      presenca('OpenAI', 'Chave de API', !!process.env.OPENAI_API_KEY, 'OPENAI_API_KEY', process.env.OPENAI_API_KEY ? fim4(process.env.OPENAI_API_KEY) : null),
    ];
    return res.status(200).json({ integracoes, obs: 'As chaves ficam nas variáveis de ambiente da Vercel e nunca aparecem aqui — só o status.' });
  } catch (e) { return res.status(500).json({ error: e.message }); }
}
