// api/whatsapp-ativar.js
// Ferramenta de ATIVAÇÃO (uma vez) do número na WhatsApp Cloud API oficial.
// Usa o token permanente que já está no Vercel — NÃO expõe o token pro navegador.
// Protegido por "chave" = o mesmo valor de WA_VERIFY_TOKEN do Vercel (só quem tem esse
// valor consegue chamar). É uma ferramenta de setup; pode ser removida depois de ativar.
//
// Passos (a página ativar-numero.html chama cada um):
//   status        -> mostra a situação atual do número (verificado? registrado?)
//   request_code  -> Meta envia um código (SMS ou ligação) pro número
//   verify_code   -> confirma o código (quem digita é o Marcio, na página)
//   register      -> define o PIN de 6 dígitos e coloca o número ONLINE
//   subscribe     -> aponta o webhook (recebimento) direto pra este sistema, no nível da WABA
//   subscribed    -> lista o que está inscrito (pra conferir)
//
// Env vars no Vercel (o Marcio cadastra; NUNCA no código):
//   WA_ACCESS_TOKEN, WA_PHONE_NUMBER_ID, WA_VERIFY_TOKEN  (todos já existem)
//   WA_WABA_ID (opcional; se não existir, usa waba_id enviado pela página)

const GRAPH = 'https://graph.facebook.com/v20.0';
const WEBHOOK_URL = 'https://sistema-grupo-aragao.vercel.app/api/whatsapp-webhook';
const SUPERADMIN = 'marcioborgesaraujojr@gmail.com';

// Admin via login da suíte (Supabase). Aceita o super-admin (dono) ou quem tem access.atendimento=true.
async function adminViaSessao(req) {
  const token = (req.headers.authorization || '').replace('Bearer ', '').trim();
  if (!token || !process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) return false;
  try {
    const r = await fetch(process.env.SUPABASE_URL + '/auth/v1/user', {
      headers: { apikey: process.env.SUPABASE_SERVICE_ROLE_KEY, Authorization: 'Bearer ' + token }
    });
    const u = await r.json();
    const email = (u && u.email ? String(u.email) : '').toLowerCase();
    if (!email) return false;
    if (email === SUPERADMIN) return true;
    const pr = await fetch(process.env.SUPABASE_URL + '/rest/v1/profiles?id=eq.' + u.id + '&select=access', {
      headers: { apikey: process.env.SUPABASE_SERVICE_ROLE_KEY, Authorization: 'Bearer ' + process.env.SUPABASE_SERVICE_ROLE_KEY }
    });
    const rows = await pr.json();
    const acc = Array.isArray(rows) && rows[0] && rows[0].access;
    return !!(acc && acc.atendimento === true);
  } catch (e) { return false; }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'authorization, content-type');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método não permitido' });

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
  body = body || {};

  // proteção: login admin da suíte OU a chave (= WA_VERIFY_TOKEN). Basta um dos dois.
  const chaveOk = !!(process.env.WA_VERIFY_TOKEN && String(body.chave || '') === String(process.env.WA_VERIFY_TOKEN));
  const adminOk = chaveOk ? true : await adminViaSessao(req);
  if (!adminOk) {
    return res.status(403).json({ error: 'Acesso negado. Faça login como admin na suíte (ou informe a chave).' });
  }
  if (!process.env.WA_ACCESS_TOKEN || !process.env.WA_PHONE_NUMBER_ID) {
    return res.status(503).json({ error: 'Faltam WA_ACCESS_TOKEN / WA_PHONE_NUMBER_ID no Vercel.' });
  }

  const PID   = process.env.WA_PHONE_NUMBER_ID;
  const WABA  = process.env.WA_WABA_ID || String(body.waba_id || '').replace(/\D/g, '');
  const AUTH  = 'Bearer ' + process.env.WA_ACCESS_TOKEN;
  const JSONH = { Authorization: AUTH, 'Content-Type': 'application/json' };
  const step  = body.step;

  async function graph(url, opts) {
    const r = await fetch(url, opts);
    let j = null; try { j = await r.json(); } catch (e) {}
    return { ok: r.ok, status: r.status, data: j };
  }

  try {
    if (step === 'status') {
      const out = await graph(
        GRAPH + '/' + PID + '?fields=display_phone_number,verified_name,code_verification_status,name_status,status,quality_rating,platform_type,throughput',
        { headers: { Authorization: AUTH } }
      );
      return res.status(out.ok ? 200 : 400).json(out);
    }

    if (step === 'request_code') {
      const method = (String(body.code_method || 'SMS').toUpperCase() === 'VOICE') ? 'VOICE' : 'SMS';
      const out = await graph(GRAPH + '/' + PID + '/request_code', {
        method: 'POST', headers: JSONH,
        body: JSON.stringify({ code_method: method, language: 'pt_BR' })
      });
      return res.status(out.ok ? 200 : 400).json(out);
    }

    if (step === 'verify_code') {
      const code = String(body.code || '').replace(/\D/g, '');
      if (code.length < 4) return res.status(400).json({ error: 'Código inválido.' });
      const out = await graph(GRAPH + '/' + PID + '/verify_code', {
        method: 'POST', headers: JSONH, body: JSON.stringify({ code })
      });
      return res.status(out.ok ? 200 : 400).json(out);
    }

    if (step === 'register') {
      const pin = String(body.pin || '').replace(/\D/g, '');
      if (pin.length !== 6) return res.status(400).json({ error: 'O PIN precisa ter 6 dígitos.' });
      const out = await graph(GRAPH + '/' + PID + '/register', {
        method: 'POST', headers: JSONH,
        body: JSON.stringify({ messaging_product: 'whatsapp', pin })
      });
      return res.status(out.ok ? 200 : 400).json(out);
    }

    if (step === 'subscribe') {
      if (!WABA) return res.status(400).json({ error: 'Falta o WABA id.' });
      // 1) Assina nosso app na WABA (aditivo — não remove outros apps já inscritos, ex.: Martz).
      const sub = await graph(GRAPH + '/' + WABA + '/subscribed_apps', { method: 'POST', headers: JSONH, body: JSON.stringify({}) });
      // 2) Aponta o webhook (recebimento) pra este sistema (override no nível da WABA, só pro nosso app).
      const over = await graph(GRAPH + '/' + WABA + '/subscribed_apps', {
        method: 'POST', headers: JSONH,
        body: JSON.stringify({ override_callback_uri: WEBHOOK_URL, verify_token: process.env.WA_VERIFY_TOKEN })
      });
      const ok = sub.ok && over.ok;
      return res.status(ok ? 200 : 400).json({ ok, assinar: sub.data, apontar_webhook: over.data });
    }

    if (step === 'subscribed') {
      if (!WABA) return res.status(400).json({ error: 'Falta o WABA id.' });
      const out = await graph(GRAPH + '/' + WABA + '/subscribed_apps', { headers: { Authorization: AUTH } });
      return res.status(out.ok ? 200 : 400).json(out);
    }

    if (step === 'debug') {
      // Diagnóstico: qual app, quais permissões (incl. granular_scopes com as WABAs), e o dono do token.
      const tok = process.env.WA_ACCESS_TOKEN;
      const me   = await graph(GRAPH + '/me?fields=id,name', { headers: { Authorization: AUTH } });
      const dbg  = await graph(GRAPH + '/debug_token?input_token=' + encodeURIComponent(tok) + '&access_token=' + encodeURIComponent(tok), { headers: { Authorization: AUTH } });
      const wabas = await graph(GRAPH + '/' + PID + '?fields=id', { headers: { Authorization: AUTH } });
      return res.status(200).json({ ok: true, me: me.data, debug_token: dbg.data, phone_check: wabas.data, phone_id_env: PID });
    }

    return res.status(400).json({ error: 'step inválido' });
  } catch (e) {
    return res.status(500).json({ error: String((e && e.message) || e) });
  }
}
