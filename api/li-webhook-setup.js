// api/li-webhook-setup.js
// Cadastra o NOSSO endereço de webhook na Loja Integrada usando a aplicação que
// já está registrada na API dela. Serve porque o cadastro de webhook não existe
// no painel da loja — só pela API.
//
// Tudo aqui exige estar logado na suíte. As chaves da loja continuam onde sempre
// estiveram (variáveis do Vercel, via lib/licfg.js) e NUNCA aparecem na resposta.
//
// GET   (Bearer)  -> sonda quais recursos de webhook a API expõe e o que já está cadastrado
// POST  (Bearer)  -> cadastra o nosso endereço
//         body opcional: { recurso: '/v1/webhook/', payload: {...} }
// DELETE (Bearer) ?recurso=...&id=123  -> remove um cadastro
//
// O endereço cadastrado é o mesmo que aparece em Automações → Loja Integrada.

import { createHash } from 'crypto';
import { getLIKeys } from '../lib/licfg.js';

const LI_API = 'https://api.awsli.com.br';

function tokenWebhook() {
  if (process.env.LI_WEBHOOK_TOKEN) return process.env.LI_WEBHOOK_TOKEN;
  const base = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  if (!base) return null;
  return 'li_' + createHash('sha256').update(base + '::li-webhook::v1').digest('hex').slice(0, 32);
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

// Chamada na API da loja. As chaves entram como parâmetro e não saem daqui.
async function li(caminho, opts = {}) {
  const k = await getLIKeys();
  const u = new URL(caminho.startsWith('http') ? caminho : LI_API + caminho);
  u.searchParams.set('chave_api', k.api);
  u.searchParams.set('chave_aplicacao', k.app);
  const r = await fetch(u.toString(), {
    ...opts,
    headers: { Accept: 'application/json', 'Content-Type': 'application/json', ...(opts.headers || {}) }
  });
  const txt = await r.text();
  let j = null; try { j = txt ? JSON.parse(txt) : null; } catch (e) { j = txt; }
  return { status: r.status, j };
}

// tira qualquer coisa que lembre chave antes de devolver pra tela
function limpar(v) {
  let s = JSON.stringify(v == null ? null : v);
  s = s.replace(/(chave_api|chave_aplicacao)=[^&"\\]+/gi, '$1=***');
  try { return JSON.parse(s); } catch (e) { return null; }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'authorization, content-type');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const email = await callerEmail((req.headers.authorization || '').replace('Bearer ', '').trim());
  if (!email) return res.status(403).json({ error: 'Faça login na suíte.' });

  const tk = tokenWebhook();
  if (!tk) return res.status(503).json({ error: 'Faltam as variáveis do Supabase no Vercel.' });

  const base = 'https://' + (req.headers['x-forwarded-host'] || req.headers.host);
  const nossaUrl = base + '/api/li-webhook?token=' + tk;
  const q = req.query || {};

  // ===== VER: onde dá pra cadastrar e o que já existe =====
  if (req.method === 'GET') {
    // ?caminho=/v1/xxx/  -> consulta livre (só leitura), pra investigar a API
    if (q.caminho) {
      const r = await li(String(q.caminho));
      const cru = typeof r.j === 'string' ? r.j.slice(0, 600) : null;
      return res.status(200).json({ caminho: String(q.caminho), status: r.status, cru, corpo: limpar(r.j) });
    }

    const tentativas = ['/v1/', '/v1/webhook/', '/v1/gatilho/', '/v1/notificacao/', '/v1/aplicacao/'];
    const achados = [];
    for (const caminho of tentativas) {
      const r = await li(caminho + '?limit=30');
      const itens = (r.j && (r.j.objects || r.j.results)) || null;
      achados.push({
        recurso: caminho,
        status: r.status,
        existe: r.status >= 200 && r.status < 300,
        quantos: Array.isArray(itens) ? itens.length : null,
        itens: Array.isArray(itens) ? limpar(itens) : null,
        chaves: (r.j && typeof r.j === 'object' && !Array.isArray(r.j)) ? Object.keys(r.j) : null,
        amostra: String(typeof r.j === 'string' ? r.j : JSON.stringify(r.j || '')).slice(0, 400),
        erro: r.status >= 400 ? String(JSON.stringify(r.j || '')).slice(0, 300) : null
      });
      // schema ajuda a saber os campos certos do POST
      if (r.status >= 200 && r.status < 300) {
        const sc = await li(caminho + 'schema/');
        achados[achados.length - 1].campos =
          sc.j && sc.j.fields ? Object.keys(sc.j.fields) : null;
        achados[achados.length - 1].metodos =
          sc.j && sc.j.allowed_list_http_methods ? sc.j.allowed_list_http_methods : null;
      }
    }
    return res.status(200).json({ nossaUrl, achados });
  }

  // ===== CADASTRAR =====
  if (req.method === 'POST') {
    let body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
    body = body || {};

    const recurso = String(body.recurso || '/v1/webhook/');
    const payload = body.payload || { url: nossaUrl, tipo: 'pedido_venda', ativo: true };

    const r = await li(recurso, { method: 'POST', body: JSON.stringify(payload) });
    const ok = r.status >= 200 && r.status < 300;

    if (ok) {
      try {
        await fetch(process.env.SUPABASE_URL + '/rest/v1/sys_audit_log', {
          method: 'POST',
          headers: { apikey: process.env.SUPABASE_SERVICE_ROLE_KEY, Authorization: 'Bearer ' + process.env.SUPABASE_SERVICE_ROLE_KEY, 'Content-Type': 'application/json' },
          body: JSON.stringify({ actor_email: email, tabela: 'li_webhook', operacao: 'INSERT',
                                 registro_id: recurso, dados_depois: { recurso, url: '(endereço do nosso webhook)' } })
        });
      } catch (e) {}
    }
    return res.status(200).json({ ok, recurso, enviado: payload, status: r.status, resposta: limpar(r.j) });
  }

  // ===== REMOVER =====
  if (req.method === 'DELETE') {
    const recurso = String(q.recurso || '/v1/webhook/');
    const id = String(q.id || '');
    if (!id) return res.status(400).json({ error: 'informe o id' });
    const r = await li(recurso + id + '/', { method: 'DELETE' });
    return res.status(200).json({ ok: r.status >= 200 && r.status < 300, status: r.status });
  }

  return res.status(405).json({ error: 'Método não permitido' });
}
