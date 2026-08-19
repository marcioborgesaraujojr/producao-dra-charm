// api/disparo-evento.js
// Motor de DISPARO automático por status de pedido (estilo Notificações Inteligentes).
// Recebe um evento normalizado (pedido_enviado, pgto_aprovado, ...), acha a regra LIGADA,
// envia o template APROVADO pelo WhatsApp Cloud API, registra no log (idempotente) e abre
// uma nota na conversa do cliente. NADA dispara sozinho: regra nasce desligada.
//
// Env vars no Vercel (o Marcio cadastra; NUNCA no código):
//   DISPARO_WEBHOOK_TOKEN   (segredo embutido na URL que a fonte de eventos usa)
//   WA_ACCESS_TOKEN, WA_PHONE_NUMBER_ID, WA_WABA_ID (fallback Dra. Charm)
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (já existem)
//
// GET  ?config=1        (Bearer suíte)  -> { catalogo, regras, templates, configurado }
// POST (Bearer suíte)   {action:'save', ...}   -> salva/atualiza uma regra
// POST (Bearer suíte)   {action:'test', evento, telefone, nome, pedido, rastreio}  -> dispara teste
// POST ?token=SECRET    {evento, telefone, nome, pedido, ...}  -> dispara de verdade (fonte de eventos)

const GRAPH = 'https://graph.facebook.com/v20.0';
const WABA  = () => process.env.WA_WABA_ID || '579587495233435';
const SB    = () => process.env.SUPABASE_URL;
const KEY   = () => process.env.SUPABASE_SERVICE_ROLE_KEY;

// Catálogo de eventos (rótulos + variáveis sugeridas). Espelha os gatilhos do Notificações.
const CATALOGO = [
  { key:'pedido_criado',       label:'Pedido criado',                  emoji:'🧾', vars:['nome','pedido'] },
  { key:'pgto_pendente',       label:'Aguardando pagamento',           emoji:'⏳', vars:['nome','pedido','link'] },
  { key:'pgto_aprovado',       label:'Pagamento aprovado',             emoji:'✅', vars:['nome','pedido'] },
  { key:'pedido_faturado',     label:'Pedido faturado / NF emitida',   emoji:'📄', vars:['nome','pedido'] },
  { key:'pedido_enviado',      label:'Pedido enviado (em transporte)', emoji:'📦', vars:['nome','pedido','rastreio'] },
  { key:'pedido_entregue',     label:'Pedido entregue',                emoji:'🎉', vars:['nome','pedido'] },
  { key:'pedido_cancelado',    label:'Pedido cancelado',               emoji:'❌', vars:['nome','pedido'] },
  { key:'carrinho_abandonado', label:'Carrinho abandonado',            emoji:'🛒', vars:['nome','link'] }
];
const CATALOGO_KEYS = new Set(CATALOGO.map(c => c.key));
const LABEL = k => (CATALOGO.find(c => c.key === k) || {}).label || k;

function normalizeWa(raw) {
  let n = String(raw || '').replace(/\D/g, '');
  if (!n) return '';
  if (n.length <= 11 && !n.startsWith('55')) n = '55' + n;
  if (n.startsWith('55') && n.length === 12) n = '55' + n.slice(2, 4) + '9' + n.slice(4);
  return n;
}

async function sb(path, opts = {}) {
  const r = await fetch(SB() + '/rest/v1/' + path, {
    ...opts,
    headers: { apikey: KEY(), Authorization: 'Bearer ' + KEY(), 'Content-Type': 'application/json', ...(opts.headers || {}) }
  });
  const txt = await r.text();
  let data = null; try { data = txt ? JSON.parse(txt) : null; } catch (e) { data = txt; }
  return { ok: r.ok, status: r.status, data };
}

async function callerEmail(token) {
  if (!token) return null;
  try {
    const r = await fetch(SB() + '/auth/v1/user', { headers: { apikey: KEY(), Authorization: 'Bearer ' + token } });
    const j = await r.json();
    return j && j.email ? String(j.email) : null;
  } catch (e) { return null; }
}

async function listarTemplates() {
  try {
    const url = GRAPH + '/' + WABA() + '/message_templates?limit=250&access_token=' + encodeURIComponent(process.env.WA_ACCESS_TOKEN);
    const r = await fetch(url); const j = await r.json();
    if (!r.ok) return [];
    return (j.data || [])
      .filter(t => t.status === 'APPROVED')
      .map(t => {
        const bodyC = (t.components || []).find(c => c.type === 'BODY');
        const bodyTxt = (bodyC && bodyC.text) || '';
        const vars = (bodyTxt.match(/\{\{\s*\d+\s*\}\}/g) || []).length;
        return { name: t.name, language: t.language, category: t.category, body: bodyTxt, vars };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch (e) { return []; }
}

async function upsertClienteConversa(waid, nome) {
  const c = await sb('at_clientes?on_conflict=whatsapp_id', {
    method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
    body: JSON.stringify({ whatsapp_id: waid, nome: nome || 'Cliente', telefone: waid })
  });
  const cli = Array.isArray(c.data) ? c.data[0] : c.data;
  if (!cli || !cli.id) return null;
  // reaproveita qualquer conversa do cliente, inclusive resolvida - assim o
  // historico fica num fio so e a automacao nao cria conversa duplicada
  const f = await sb('at_conversas?cliente_id=eq.' + cli.id + '&select=id&order=ultima_msg_em.desc.nullslast&limit=1');
  if (Array.isArray(f.data) && f.data.length) return f.data[0].id;
  // nasce ja resolvida e lida: e so aviso automatico, nao e atendimento
  const nv = await sb('at_conversas', {
    method: 'POST', headers: { Prefer: 'return=representation' },
    body: JSON.stringify({ cliente_id: cli.id, canal: 'loja', status: 'encerrada', nao_lida: false, ultima_msg_em: new Date().toISOString() })
  });
  const conv = Array.isArray(nv.data) ? nv.data[0] : nv.data;
  return conv && conv.id ? conv.id : null;
}

// Núcleo: dispara 1 evento. Retorna {status, detalhe}.
async function fireEvento(dados) {
  const evento = String(dados.evento || '').trim();
  if (!CATALOGO_KEYS.has(evento)) return { status: 'erro', detalhe: 'evento desconhecido: ' + evento };
  const waid = normalizeWa(dados.telefone || dados.phone || dados.whatsapp);
  if (!waid) return { status: 'erro', detalhe: 'sem telefone' };
  const pedido = dados.pedido != null ? String(dados.pedido) : '';

  // regra LIGADA?
  const rr = await sb('at_disparos?evento_key=eq.' + encodeURIComponent(evento) + '&select=*');
  const regra = Array.isArray(rr.data) ? rr.data[0] : null;
  if (!regra || !regra.ativo || !regra.template_name) {
    return { status: 'pulado', detalhe: 'regra desligada ou sem template' };
  }

  // idempotência: mesmo evento+pedido+telefone enviado nas últimas 12h -> não repete
  if (pedido) {
    const since = new Date(Date.now() - 12 * 3600 * 1000).toISOString();
    const dup = await sb('at_disparos_log?evento_key=eq.' + encodeURIComponent(evento) +
      '&pedido=eq.' + encodeURIComponent(pedido) + '&telefone=eq.' + encodeURIComponent(waid) +
      '&status=eq.enviado&created_at=gte.' + encodeURIComponent(since) + '&select=id&limit=1');
    if (Array.isArray(dup.data) && dup.data.length) return { status: 'pulado', detalhe: 'já enviado (idempotência)' };
  }

  // monta os parâmetros do template a partir do mapa da regra
  const fonte = {
    nome: dados.nome || 'Cliente', pedido: pedido || '-',
    rastreio: dados.rastreio || dados.tracking || '-', link: dados.link || '-',
    valor: dados.valor || '-', extra: dados.extra || '-'
  };
  const mapa = Array.isArray(regra.mapa) ? regra.mapa : [];
  const params = mapa.map(k => { const v = fonte[k]; return (v == null || v === '') ? '-' : String(v); });

  const template = { name: regra.template_name, language: { code: regra.template_language || 'pt_BR' } };
  if (params.length) template.components = [{ type: 'body', parameters: params.map(p => ({ type: 'text', text: p })) }];

  // envia
  let wamid = null, erro = null, ok = false;
  try {
    const r = await fetch(GRAPH + '/' + process.env.WA_PHONE_NUMBER_ID + '/messages', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + process.env.WA_ACCESS_TOKEN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', to: waid, type: 'template', template })
    });
    const j = await r.json();
    if (r.ok) { ok = true; wamid = j && j.messages && j.messages[0] && j.messages[0].id || null; }
    else { erro = (j && j.error && j.error.message) || ('erro ' + r.status); }
  } catch (e) { erro = e.message; }

  // nota no painel + preview na conversa
  try {
    const conversaId = await upsertClienteConversa(waid, dados.nome);
    if (conversaId) {
      const nota = '📤 Disparo: ' + LABEL(evento) + (pedido ? (' — pedido ' + pedido) : '') + (ok ? '' : ' (FALHOU: ' + erro + ')');
      await sb('at_mensagens', {
        method: 'POST',
        body: JSON.stringify({ conversa_id: conversaId, direcao: ok ? 'out' : 'in', tipo: ok ? 'template' : 'nota',
          conteudo: nota, autor: 'Disparo automático', meta: { disparo: evento, pedido } })
      });
      await sb('at_conversas?id=eq.' + conversaId, {
        method: 'PATCH',
        body: JSON.stringify({ ultima_msg_preview: nota.slice(0, 120), ultima_msg_em: new Date().toISOString(),
          janela_expira_em: new Date(Date.now() + 24 * 3600 * 1000).toISOString() })
      });
    }
  } catch (e) { /* nota é best-effort */ }

  await sb('at_disparos_log', {
    method: 'POST',
    body: JSON.stringify({ evento_key: evento, telefone: waid, pedido: pedido || null,
      template_name: regra.template_name, status: ok ? 'enviado' : 'erro', detalhe: erro,
      wamid, payload: dados })
  });

  return ok ? { status: 'enviado', wamid } : { status: 'erro', detalhe: erro };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'authorization, content-type');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const q = req.query || {};

  // ===== CONFIG (tela /disparos.html) =====
  if (req.method === 'GET' && q.config) {
    const email = await callerEmail((req.headers.authorization || '').replace('Bearer ', '').trim());
    if (!email) return res.status(403).json({ error: 'Faça login na suíte.' });
    const rr = await sb('at_disparos?select=*');
    const regras = Array.isArray(rr.data) ? rr.data : [];
    const templates = process.env.WA_ACCESS_TOKEN ? await listarTemplates() : [];
    return res.status(200).json({
      catalogo: CATALOGO, regras, templates,
      configurado: !!process.env.DISPARO_WEBHOOK_TOKEN,
      wa_ok: !!(process.env.WA_ACCESS_TOKEN && process.env.WA_PHONE_NUMBER_ID)
    });
  }

  if (req.method !== 'POST') return res.status(405).json({ error: 'Método não permitido' });

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
  body = body || {};

  // ===== AÇÕES AUTENTICADAS (salvar regra / testar) =====
  if (body.action === 'save' || body.action === 'test') {
    const email = await callerEmail((req.headers.authorization || '').replace('Bearer ', '').trim());
    if (!email) return res.status(403).json({ error: 'Faça login na suíte.' });

    if (body.action === 'save') {
      const evento_key = String(body.evento_key || '');
      if (!CATALOGO_KEYS.has(evento_key)) return res.status(400).json({ error: 'evento inválido' });
      const row = {
        evento_key, ativo: !!body.ativo,
        template_name: body.template_name || null,
        template_language: body.template_language || 'pt_BR',
        mapa: Array.isArray(body.mapa) ? body.mapa : [],
        updated_at: new Date().toISOString()
      };
      if (row.ativo && !row.template_name) return res.status(400).json({ error: 'Escolha um template pra ligar o gatilho.' });
      const up = await sb('at_disparos?on_conflict=evento_key', {
        method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
        body: JSON.stringify(row)
      });
      if (!up.ok) return res.status(400).json({ error: 'Falha ao salvar', detalhe: up.data });
      return res.status(200).json({ ok: true, regra: Array.isArray(up.data) ? up.data[0] : up.data });
    }

    // action === 'test' -> dispara de verdade pro número informado (o próprio Marcio testando)
    if (!process.env.WA_ACCESS_TOKEN || !process.env.WA_PHONE_NUMBER_ID) {
      return res.status(503).json({ error: 'WhatsApp não configurado (WA_ACCESS_TOKEN / WA_PHONE_NUMBER_ID).' });
    }
    const out = await fireEvento({
      evento: body.evento, telefone: body.telefone, nome: body.nome || 'Teste',
      pedido: body.pedido || ('TESTE-' + (body.evento || '')), rastreio: body.rastreio, link: body.link, valor: body.valor
    });
    return res.status(200).json({ ok: out.status === 'enviado', resultado: out });
  }

  // ===== GATILHO REAL (fonte de eventos: Loja Integrada / Bling / etc.) =====
  const token = process.env.DISPARO_WEBHOOK_TOKEN;
  if (!token) return res.status(503).json({ error: 'Falta DISPARO_WEBHOOK_TOKEN no Vercel.' });
  if (q.token !== token) return res.status(401).json({ error: 'token inválido' });
  if (!process.env.WA_ACCESS_TOKEN || !process.env.WA_PHONE_NUMBER_ID) {
    return res.status(200).json({ received: true, skipped: 'wa não configurado' });
  }
  try {
    const out = await fireEvento(body);
    return res.status(200).json({ received: true, resultado: out });
  } catch (err) {
    console.error('disparo-evento erro:', err.message);
    return res.status(200).json({ received: true, error: err.message });
  }
}
