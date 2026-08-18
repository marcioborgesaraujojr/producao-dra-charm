// api/li-webhook-setup.js
// Cadastra o NOSSO endereço de webhook na Loja Integrada.
//
// O endpoint certo (achado na documentação oficial da LI) é:
//     PUT    https://api.awsli.com.br/webhooks/v1/pedido    { notifyUrl, token }
//     DELETE https://api.awsli.com.br/webhooks/v1/pedido
// (não é /v1/webhook/ — por isso a sondagem inicial não achava nada)
//
// Autenticação: header Authorization: "chave_api <X> aplicacao <Y>"
//
// Tudo aqui exige estar logado na suíte. As chaves da loja continuam nas
// variáveis do Vercel (lib/licfg.js) e NUNCA aparecem na resposta.
//
// GET    (Bearer)                 -> mostra o endereço que será cadastrado
// GET    (Bearer) ?caminho=/v1/x  -> consulta livre na API da loja (só leitura)
// POST   (Bearer)                 -> cadastra (PUT na LI)
// DELETE (Bearer)                 -> remove o cadastro

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

// Chamada na API da loja, autenticando pelo header (jeito documentado).
async function li(caminho, opts = {}) {
  const k = await getLIKeys();
  const r = await fetch(caminho.startsWith('http') ? caminho : LI_API + caminho, {
    ...opts,
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Authorization: 'chave_api ' + k.api + ' aplicacao ' + k.app,
      ...(opts.headers || {})
    }
  });
  const txt = await r.text();
  let j = null; try { j = txt ? JSON.parse(txt) : null; } catch (e) { j = txt; }
  return { status: r.status, j };
}

// nunca deixa vazar nada parecido com chave na resposta
function limpar(v) {
  let s = JSON.stringify(v == null ? null : v);
  s = s.replace(/(chave_api|chave_aplicacao|aplicacao)[=:\s"]+[A-Za-z0-9-]{8,}/gi, '$1=***');
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
  const RECURSO = '/webhooks/v1/pedido';

  // ===== consulta livre / estado =====
  if (req.method === 'GET') {
    if (q.caminho) {
      const r = await li(String(q.caminho));
      const cru = typeof r.j === 'string' ? r.j.slice(0, 600) : null;
      return res.status(200).json({ caminho: String(q.caminho), status: r.status, cru, corpo: limpar(r.j) });
    }
    return res.status(200).json({ nossaUrl, recurso: RECURSO, metodo: 'PUT' });
  }

  // ===== CADASTRAR (PUT na Loja Integrada) =====
  if (req.method === 'POST') {
    const r = await li(RECURSO, {
      method: 'PUT',
      body: JSON.stringify({ notifyUrl: nossaUrl, token: tk })
    });
    const ok = r.status >= 200 && r.status < 300;

    if (ok) {
      try {
        await fetch(process.env.SUPABASE_URL + '/rest/v1/sys_audit_log', {
          method: 'POST',
          headers: { apikey: process.env.SUPABASE_SERVICE_ROLE_KEY, Authorization: 'Bearer ' + process.env.SUPABASE_SERVICE_ROLE_KEY, 'Content-Type': 'application/json' },
          body: JSON.stringify({ actor_email: email, tabela: 'li_webhook', operacao: 'INSERT',
                                 registro_id: RECURSO, dados_depois: { notifyUrl: nossaUrl } })
        });
      } catch (e) {}
    }
    return res.status(200).json({ ok, status: r.status, notifyUrl: nossaUrl, resposta: limpar(r.j) });
  }

  // ===== REMOVER =====
  if (req.method === 'DELETE') {
    const r = await li(RECURSO, { method: 'DELETE' });
    return res.status(200).json({ ok: r.status >= 200 && r.status < 300, status: r.status, resposta: limpar(r.j) });
  }

  return res.status(405).json({ error: 'Método não permitido' });
}
