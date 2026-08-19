// api/troquecommerce-webhook.js
// Recebe os eventos de TROCA e DEVOLUÇÃO da TroqueCommerce e dispara a
// notificação do WhatsApp pelo gatilho correspondente em at_gatilhos
// (loja = 'troquecommerce'). Mesmo motor da Loja Integrada.
//
// Onde cadastrar a URL:
//   TroqueCommerce → Automações e Integrações → Webhook
//   Ativar · Nome: "Sistema Aragão" · Header: em branco
//   Marcar os eventos desejados · Salvar
//
// A TroqueCommerce não documenta o formato do corpo publicamente. Por isso este
// receptor é DEFENSIVO: guarda o payload cru inteiro em loja_eventos.payload
// (a tela de Automações monta o catálogo de variáveis a partir dele) e procura
// telefone/nome/pedido em vários nomes de campo comuns.
//
// Env vars (o Marcio cadastra; NUNCA no código):
//   TROQUE_WEBHOOK_TOKEN (opcional — se faltar, o segredo é derivado igual ao da LI)
//   WA_ACCESS_TOKEN, WA_PHONE_NUMBER_ID, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
//
// GET  ?config=1  (Bearer) -> URL do webhook, últimos eventos, variáveis, não mapeados
// GET             (sem nada) -> 200 "ok"  (ping de saúde)
// POST ?token=... -> processa 1 evento

import { createHash } from 'crypto';

const GRAPH = 'https://graph.facebook.com/v20.0';
const SB    = () => process.env.SUPABASE_URL;
const KEY   = () => process.env.SUPABASE_SERVICE_ROLE_KEY;
const LOJA  = 'troquecommerce';

// Códigos de evento da TroqueCommerce -> nosso evento_code em at_gatilhos
const EVENTOS = {
  '2':  { code: 'reversa_criada',     label: 'Logística reversa criada' },
  '3':  { code: 'reversa_autorizada', label: 'Logística reversa autorizada' },
  '4':  { code: 'reversa_cancelada',  label: 'Logística reversa cancelada' },
  '10': { code: 'estorno_pagamento',  label: 'Estorno do pagamento feito' },
  '11': { code: 'vale_gerado',        label: 'Vale gerado' },
  '17': { code: 'reversa_criada',     label: 'Reversa reaberta (nova postagem)' },
  '20': { code: 'troca_reservada',    label: 'Pedido de troca reservado' },
  '21': { code: 'troca_aprovada',     label: 'Pedido de troca aprovado' },
  '32': { code: 'reversa_entregue',   label: 'Logística reversa entregue' },
  '33': { code: 'pacote_despachado',  label: 'Pacote despachado' }
};

function tokenWebhook() {
  if (process.env.TROQUE_WEBHOOK_TOKEN) return process.env.TROQUE_WEBHOOK_TOKEN;
  const base = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  if (!base) return null;
  return 'tq_' + createHash('sha256').update(base + '::troque-webhook::v1').digest('hex').slice(0, 32);
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

// ===== ESPELHO =====
// A TroqueCommerce guarda a lista de webhooks, mas o painel so deixa editar UM.
// Enquanto o Notificacoes Inteligentes ainda estiver no ar, o NOSSO endereco
// fica cadastrado la e REPASSA uma copia identica do evento pro endereco antigo,
// pra nada parar de funcionar durante a virada.
// Endereco do espelho: sys_config.chave = 'troque_espelho_url'
//   (apagar a linha, ou deixar em branco, desliga o repasse)
let _espCache = { v: null, em: 0 };
async function espelhoUrl() {
  if (Date.now() - _espCache.em < 60000) return _espCache.v;
  let v = null;
  try {
    const r = await sb('sys_config?chave=eq.troque_espelho_url&select=valor&limit=1');
    const row = Array.isArray(r.data) ? r.data[0] : null;
    if (row && row.valor && /^https:\/\//.test(String(row.valor).trim())) v = String(row.valor).trim();
  } catch (e) { v = null; }
  _espCache = { v, em: Date.now() };
  return v;
}
async function espelhar(body) {
  const url = await espelhoUrl();
  if (!url) return null;
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 6000);
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: ctl.signal });
    clearTimeout(t);
    return r.status;
  } catch (e) { return 'falhou'; }
}

let _secoCache = { v: true, em: 0 };
async function modoSeco() {
  if (Date.now() - _secoCache.em < 30000) return _secoCache.v;
  let v = true;
  try {
    const r = await sb('sys_config?chave=eq.disparo_seco&select=valor&limit=1');
    const row = Array.isArray(r.data) ? r.data[0] : null;
    if (row) v = ['1', 'true', 'sim'].includes(String(row.valor).toLowerCase());
  } catch (e) { v = true; }
  _secoCache = { v, em: Date.now() };
  return v;
}

function normalizeWa(raw) {
  let n = String(raw || '').replace(/\D/g, '');
  if (!n) return '';
  if (n.length <= 11 && !n.startsWith('55')) n = '55' + n;
  if (n.startsWith('55') && n.length === 12) n = '55' + n.slice(2, 4) + '9' + n.slice(4);
  return n;
}

function valorDoCaminho(obj, caminho) {
  if (!caminho) return null;
  let v = obj;
  for (const parte of String(caminho).split('.')) {
    if (v == null) return null;
    v = Array.isArray(v) ? v[Number(parte)] : v[parte];
  }
  if (v == null || typeof v === 'object') return null;
  return String(v);
}

function achatar(obj, prefixo, saida, nivel) {
  saida = saida || {}; nivel = nivel || 0;
  if (obj == null || nivel > 3) return saida;
  if (Array.isArray(obj)) { if (obj.length) achatar(obj[0], (prefixo ? prefixo + '.' : '') + '0', saida, nivel + 1); return saida; }
  if (typeof obj === 'object') { for (const k of Object.keys(obj)) achatar(obj[k], (prefixo ? prefixo + '.' : '') + k, saida, nivel + 1); return saida; }
  if (prefixo) saida[prefixo] = String(obj).slice(0, 60);
  return saida;
}

// procura um valor em varios nomes possiveis (a doc da TroqueCommerce nao e publica).
// Primeiro tenta o caminho exato; so depois aceita "termina com".
function garimpa(obj, nomes) {
  const plano = achatar(obj);
  const chaves = Object.keys(plano);
  for (const n of nomes) {
    const exato = chaves.find(c => c.toLowerCase() === n.toLowerCase());
    if (exato && plano[exato]) return plano[exato];
  }
  for (const n of nomes) {
    const achou = chaves.find(c => c.toLowerCase().endsWith('.' + n.toLowerCase()));
    if (achou && plano[achou]) return plano[achou];
  }
  for (const n of nomes) {
    const achou = chaves.find(c => c.toLowerCase().endsWith(n.toLowerCase()));
    if (achou && plano[achou]) return plano[achou];
  }
  return '';
}

// O codigo do evento pode chegar solto ou dentro de um envelope.
function codigoEvento(b) {
  const cand = [b.evento, b.event_id, b.eventId, b.codigo, b.code, b.tipo, b.type, b.event];
  for (const c of cand) {
    if (c == null) continue;
    if (typeof c === 'object') { const i = c.id || c.code || c.codigo; if (i != null) return String(i).trim(); continue; }
    const s = String(c).trim();
    if (s && EVENTOS[s]) return s;
  }
  for (const c of cand) { if (c != null && typeof c !== 'object' && String(c).trim()) return String(c).trim(); }
  return String(b.status || '').trim();
}

function lerEvento(b) {
  const cod = codigoEvento(b);
  const ev  = EVENTOS[cod] || null;
  return {
    codigoBruto: cod,
    code:   ev ? ev.code : ('desconhecido_' + (cod || 'sem_codigo')),
    label:  ev ? ev.label : ('Evento ' + (cod || '?')),
    nome:   garimpa(b, ['client.name', 'cliente.nome', 'customer.name', 'first_name', 'nome_cliente', 'nome']),
    email:  garimpa(b, ['client.email', 'email']) || null,
    waid:   normalizeWa(garimpa(b, ['client.phone', 'telefone_celular', 'celular', 'phone', 'telefone', 'whatsapp'])),
    pedido: garimpa(b, ['ecommerce_number', 'numero_pedido', 'order_id', 'pedido', 'numero'])
  };
}

// Um item do mapa do gatilho pode ser:
//   "client.name"                  -> valor que veio no webhook
//   "nome" / "pedido" / "aviso"    -> atalhos prontos
//   "txt:em ate 7 dias uteis"      -> texto fixo (quando a loja nao manda o dado)
//   "brl:reverse_coupon.value"     -> 189.9      vira  R$ 189,90
//   "data:reverse_coupon.validity" -> 2026-12-31 vira  31/12/2026
function resolverVar(k, body, atalhos) {
  k = String(k || '');
  if (k.slice(0, 4) === 'txt:') return k.slice(4).trim() || '-';
  let fmt = null, caminho = k;
  const m = /^(brl|data):(.+)$/.exec(k);
  if (m) { fmt = m[1]; caminho = m[2]; }
  let v = (atalhos[caminho] != null && atalhos[caminho] !== '') ? String(atalhos[caminho]) : valorDoCaminho(body, caminho);
  if (v == null || v === '') return '-';
  if (fmt === 'brl') {
    const n = Number(String(v).replace(/[^\d.,-]/g, '').replace(',', '.'));
    if (!isFinite(n)) return String(v);
    const p = n.toFixed(2).split('.');
    return 'R$ ' + p[0].replace(/\B(?=(\d{3})+(?!\d))/g, '.') + ',' + p[1];
  }
  if (fmt === 'data') {
    const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(v));
    if (iso) return iso[3] + '/' + iso[2] + '/' + iso[1];
    const d = new Date(v);
    if (!isNaN(d.getTime())) {
      const z = x => String(x).padStart(2, '0');
      return z(d.getUTCDate()) + '/' + z(d.getUTCMonth() + 1) + '/' + d.getUTCFullYear();
    }
  }
  return String(v);
}

async function acharConversa(waid) {
  try {
    const c = await sb('at_clientes?whatsapp_id=eq.' + waid + '&select=id&limit=1');
    const cli = Array.isArray(c.data) ? c.data[0] : null;
    if (!cli || !cli.id) return null;
    // qualquer conversa do cliente serve - inclusive a que ja foi resolvida,
    // pro historico ficar num fio so e nada sumir quando a equipe clica em Resolver.
    const f = await sb('at_conversas?cliente_id=eq.' + cli.id + '&select=id&order=ultima_msg_em.desc.nullslast&limit=1');
    return (Array.isArray(f.data) && f.data.length) ? f.data[0].id : null;
  } catch (e) { return null; }
}

async function acharOuCriarConversa(waid, nome) {
  const c = await sb('at_clientes?on_conflict=whatsapp_id', {
    method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
    body: JSON.stringify({ whatsapp_id: waid, nome: nome || 'Cliente', telefone: waid })
  });
  const cli = Array.isArray(c.data) ? c.data[0] : c.data;
  if (!cli || !cli.id) return null;
  // reaproveita a ultima conversa do cliente, mesmo resolvida - reabre em vez de criar outra
  const f = await sb('at_conversas?cliente_id=eq.' + cli.id + '&select=id,status&order=ultima_msg_em.desc.nullslast&limit=1');
  if (Array.isArray(f.data) && f.data.length) {
    const ja = f.data[0];
    if (ja.status === 'encerrada') {
      await sb('at_conversas?id=eq.' + ja.id, { method: 'PATCH', body: JSON.stringify({ status: 'aberta' }) });
    }
    return ja.id;
  }
  const nv = await sb('at_conversas', {
    method: 'POST', headers: { Prefer: 'return=representation' },
    body: JSON.stringify({ cliente_id: cli.id, canal: 'loja', status: 'aberta', nao_lida: true, ultima_msg_em: new Date().toISOString() })
  });
  const conv = Array.isArray(nv.data) ? nv.data[0] : nv.data;
  return conv && conv.id ? conv.id : null;
}

async function aplicarTags(conversaId, tags) {
  if (!conversaId || !Array.isArray(tags) || !tags.length) return;
  try {
    const todas = await sb('at_tags?select=id,nome');
    const lista = Array.isArray(todas.data) ? todas.data : [];
    const acharId = n => (lista.find(t => String(t.nome).toLowerCase() === String(n).toLowerCase()) || {}).id;
    for (const nome of tags) {
      let id = acharId(nome);
      if (!id) {
        const nv = await sb('at_tags', { method: 'POST', headers: { Prefer: 'return=representation' },
          body: JSON.stringify({ nome, cor: '#ff3c6f' }) });
        const t = Array.isArray(nv.data) ? nv.data[0] : nv.data;
        id = t && t.id; if (id) lista.push({ id, nome });
      }
      if (!id) continue;
      const grupo = String(nome).includes('::') ? String(nome).split('::')[0] + '::' : null;
      if (grupo) {
        const irmas = lista.filter(t => String(t.nome).startsWith(grupo) && t.id !== id).map(t => t.id);
        if (irmas.length) await sb('at_conversa_tags?conversa_id=eq.' + conversaId + '&tag_id=in.(' + irmas.join(',') + ')', { method: 'DELETE' });
      }
      await sb('at_conversa_tags?on_conflict=conversa_id,tag_id', {
        method: 'POST', headers: { Prefer: 'resolution=ignore-duplicates' },
        body: JSON.stringify({ conversa_id: conversaId, tag_id: id }) });
    }
  } catch (e) { /* etiqueta é bônus */ }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'authorization, content-type');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const q = req.query || {};
  const tk = tokenWebhook();

  // ===== CONFIG (tela de Automações) =====
  if (req.method === 'GET' && q.config) {
    const email = await callerEmail((req.headers.authorization || '').replace('Bearer ', '').trim());
    if (!email) return res.status(403).json({ error: 'Faça login na suíte.' });

    const base = 'https://' + (req.headers['x-forwarded-host'] || req.headers.host);
    const ev = await sb('loja_eventos?loja=eq.' + LOJA + '&select=evento_codigo,evento_label,cliente_nome,pedido,created_at&order=created_at.desc&limit=40');
    const recentes = Array.isArray(ev.data) ? ev.data : [];

    const gt = await sb('at_gatilhos?loja=eq.' + LOJA + '&select=evento_code,ativo,template_name');
    const gatilhos = Array.isArray(gt.data) ? gt.data : [];
    const conhecidos = new Set(gatilhos.map(g => g.evento_code));
    const naoMapeados = [...new Set(recentes.map(r => r.evento_codigo).filter(c => c && !conhecidos.has(c)))];

    let variaveis = [];
    try {
      const um = await sb('loja_eventos?loja=eq.' + LOJA + '&payload=not.is.null&select=payload&order=created_at.desc&limit=1');
      const pl = Array.isArray(um.data) && um.data[0] ? um.data[0].payload : null;
      if (pl) {
        const plano = achatar(pl);
        variaveis = Object.keys(plano).map(c => ({ caminho: c, rotulo: c, exemplo: plano[c], conhecido: false }));
      }
    } catch (e) {}
    variaveis.unshift({ caminho: 'aviso', rotulo: 'Frase fixa (a mesma pra todos)', exemplo: '(texto que você define)', conhecido: true });

    let tplMapas = {};
    try {
      const mp = await sb('sys_config?chave=like.tplmap_*&select=chave,valor');
      (Array.isArray(mp.data) ? mp.data : []).forEach(r => {
        try { tplMapas[String(r.chave).replace('tplmap_', '')] = JSON.parse(r.valor); } catch (e) {}
      });
    } catch (e) {}

    return res.status(200).json({
      variaveis, tplMapas, recentes, naoMapeados,
      url: tk ? (base + '/api/troquecommerce-webhook?token=' + tk) : null,
      configurado: !!tk,
      wa_ok: !!(process.env.WA_ACCESS_TOKEN && process.env.WA_PHONE_NUMBER_ID),
      modo_seco: await modoSeco()
    });
  }

  if (req.method === 'GET') return res.status(200).send('ok');
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método não permitido' });
  if (!tk) return res.status(503).json({ error: 'Faltam as variáveis do Supabase no Vercel.' });

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
  body = body || {};

  const tokenRecebido = q.token || req.headers['x-webhook-token'] ||
    (req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim() || body.token || null;
  if (tokenRecebido !== tk) return res.status(401).json({ error: 'token inválido' });

  // repassa uma copia pro Notificacoes Inteligentes (enquanto a virada nao termina)
  try { await espelhar(body); } catch (e) {}

  // Daqui pra baixo nunca devolvemos erro: se responder != 2xx, a TroqueCommerce
  // reenvia o evento e o cliente leva mensagem repetida.
  try {
    const p = lerEvento(body);

    await sb('loja_eventos', {
      method: 'POST',
      body: JSON.stringify({
        loja: LOJA, evento_codigo: p.code, evento_label: p.label,
        cliente_nome: p.nome, cliente_telefone: p.waid || null, cliente_email: p.email,
        pedido: p.pedido || null, payload: body
      })
    });

    const gr = await sb('at_gatilhos?loja=eq.' + LOJA + '&evento_code=eq.' + encodeURIComponent(p.code) + '&select=*');
    const g = Array.isArray(gr.data) ? gr.data[0] : null;
    if (!g)       return res.status(200).json({ received: true, resultado: 'evento sem gatilho: ' + p.code });
    if (!g.ativo) return res.status(200).json({ received: true, resultado: 'gatilho desligado' });
    if (!p.waid)  return res.status(200).json({ received: true, resultado: 'cliente sem telefone' });

    const desde = new Date(Date.now() - 12 * 3600 * 1000).toISOString();
    const dup = await sb('at_disparos_log?evento_key=eq.' + encodeURIComponent(p.code) +
      '&pedido=eq.' + encodeURIComponent(p.pedido || '-') + '&telefone=eq.' + p.waid +
      '&status=eq.enviado&created_at=gte.' + encodeURIComponent(desde) + '&select=id&limit=1');
    if (Array.isArray(dup.data) && dup.data.length) {
      return res.status(200).json({ received: true, resultado: 'já avisado (12h)' });
    }

    let aviso = 'Qualquer dúvida, é só responder por aqui.';
    try {
      const av = await sb('sys_config?chave=eq.disparo_aviso&select=valor&limit=1');
      const r0 = Array.isArray(av.data) ? av.data[0] : null;
      if (r0 && r0.valor) aviso = String(r0.valor);
    } catch (e) {}

    const atalhos = { nome: p.nome, pedido: p.pedido, aviso };
    const mapa = Array.isArray(g.template_mapa) ? g.template_mapa : [];
    const params = mapa.map(k => resolverVar(k, body, atalhos));

    if (!g.template_name) {
      await sb('at_disparos_log', { method: 'POST', body: JSON.stringify({
        evento_key: p.code, telefone: p.waid, pedido: p.pedido || null,
        status: 'aguardando_modelo',
        detalhe: 'gatilho "' + (g.evento_nome || p.code) + '" está ligado, mas falta escolher o modelo aprovado',
        payload: atalhos }) });
      return res.status(200).json({ received: true, resultado: 'falta escolher o modelo' });
    }

    const seco = await modoSeco();
    if (seco || !process.env.WA_ACCESS_TOKEN || !process.env.WA_PHONE_NUMBER_ID) {
      await sb('at_disparos_log', { method: 'POST', body: JSON.stringify({
        evento_key: p.code, telefone: p.waid, pedido: p.pedido || null,
        template_name: g.template_name, status: 'simulado',
        detalhe: seco ? 'modo seco ligado' : 'whatsapp não configurado', payload: { params, atalhos } }) });
      try {
        const cid = await acharConversa(p.waid);
        if (cid) await aplicarTags(cid, g.aplica_tags);
      } catch (e) {}
      return res.status(200).json({ received: true, resultado: 'simulado', params });
    }

    const template = { name: g.template_name, language: { code: g.template_language || 'pt_BR' } };
    if (params.length) template.components = [{ type: 'body', parameters: params.map(x => ({ type: 'text', text: x })) }];

    let ok = false, erro = null, wamid = null;
    try {
      const r = await fetch(GRAPH + '/' + process.env.WA_PHONE_NUMBER_ID + '/messages', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + process.env.WA_ACCESS_TOKEN, 'Content-Type': 'application/json' },
        body: JSON.stringify({ messaging_product: 'whatsapp', to: p.waid, type: 'template', template })
      });
      const j = await r.json();
      if (r.ok) { ok = true; wamid = (j.messages && j.messages[0] && j.messages[0].id) || null; }
      else erro = (j.error && j.error.message) || ('erro ' + r.status);
    } catch (e) { erro = e.message; }

    try {
      const conversaId = ok ? await acharOuCriarConversa(p.waid, p.nome) : await acharConversa(p.waid);
      if (conversaId) {
        await aplicarTags(conversaId, g.aplica_tags);
        let texto = g.mensagem || ('[modelo: ' + g.template_name + ']');
        params.forEach((x, i) => { texto = texto.replace(new RegExp('\\{\\{\\s*' + (i + 1) + '\\s*\\}\\}', 'g'), x); });
        const nota = ok ? texto : ('Falhou o aviso "' + (g.evento_nome || p.label) + '": ' + erro);
        await sb('at_mensagens', { method: 'POST', body: JSON.stringify({
          conversa_id: conversaId, direcao: ok ? 'out' : 'in', tipo: ok ? 'template' : 'nota',
          conteudo: nota, autor: 'Automação · TroqueCommerce',
          meta: { gatilho: g.evento_code, pedido: p.pedido } }) });
        const patch = {
          ultima_msg_preview: nota.slice(0, 120), ultima_msg_em: new Date().toISOString(),
          janela_expira_em: new Date(Date.now() + 24 * 3600 * 1000).toISOString() };
        // amarra o pedido na conversa pra aparecer no painel do atendimento
        if (p.pedido) patch.pedido_numero = String(p.pedido);
        await sb('at_conversas?id=eq.' + conversaId, { method: 'PATCH', body: JSON.stringify(patch) });
      }
    } catch (e) { /* nota é bônus */ }

    await sb('at_disparos_log', { method: 'POST', body: JSON.stringify({
      evento_key: p.code, telefone: p.waid, pedido: p.pedido || null,
      template_name: g.template_name, status: ok ? 'enviado' : 'erro',
      detalhe: erro, wamid, payload: { params, atalhos } }) });

    return res.status(200).json({ received: true, resultado: ok ? 'enviado' : 'erro', detalhe: erro });

  } catch (err) {
    console.error('troquecommerce-webhook erro:', err && err.message);
    return res.status(200).json({ received: true, error: err && err.message });
  }
}
