// api/troquecommerce-webhook.js
// Recebe eventos da TroqueCommerce (plataforma de TROCAS e DEVOLUÇÕES / logística reversa)
// e joga no painel de atendimento, do mesmo jeito que o notificacoesinteligentes faz.
//
// Como funciona (igual ao concorrente):
//   Na TroqueCommerce → "Automações e Integrações" → "Webhook":
//     • Ativar o webhook
//     • Nome: "Sistema Aragão"
//     • URL: a que aparece na nossa página /lojas.html (já vem com o ?token=...)
//     • Header: deixar em branco
//     • Eventos: marcar os que quiser (reversa criada, aprovada, reembolso, vale-troca, etc.)
//     • Salvar
//
// A TroqueCommerce NÃO documenta publicamente o formato do corpo (payload). Por isso este
// receptor é DEFENSIVO: guarda o corpo cru inteiro em loja_eventos.payload (pra gente ver o
// primeiro evento real e afinar o mapeamento) e ainda tenta extrair telefone/nome/pedido
// procurando em vários nomes de campo comuns. Nada quebra se um campo faltar.
//
// Env vars no Vercel (o Marcio cadastra; NUNCA no código):
//   TROQUE_WEBHOOK_TOKEN        (segredo que vai embutido na URL do webhook)
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (já existem)
//
// GET  ?config=1  (com Bearer da suíte) -> { url, recentes:[...] }   (pra página /lojas.html)
// GET             (sem nada)            -> 200 "ok"                   (ping de saúde da TroqueCommerce)
// POST ?token=SECRET                    -> processa 1 evento

const SB  = () => process.env.SUPABASE_URL;
const KEY = () => process.env.SUPABASE_SERVICE_ROLE_KEY;

// Mapa dos códigos de evento da TroqueCommerce (os que a doc lista).
// Se vier um código fora da lista, a gente ainda registra com rótulo genérico.
const EVENTOS = {
  '2':  'Reversa criada (em análise)',
  '3':  'Reversa aprovada (autorização/coleta)',
  '4':  'Reversa cancelada',
  '10': 'Reembolso realizado',
  '11': 'Vale-troca gerado',
  '17': 'Reversa reaberta (nova postagem)',
  '20': 'Pedido de troca reservado',
  '21': 'Pedido de troca aprovado',
  '32': 'Reversa entregue',
  '33': 'Reversa postada (em trânsito)'
};

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

// procura um valor em vários caminhos possíveis dentro do objeto (busca rasa + 1 nível)
function pick(obj, names) {
  if (!obj || typeof obj !== 'object') return null;
  const lower = {};
  for (const k of Object.keys(obj)) lower[k.toLowerCase()] = obj[k];
  for (const n of names) {
    const v = lower[n.toLowerCase()];
    if (v != null && typeof v !== 'object' && String(v).trim() !== '') return String(v).trim();
  }
  // desce 1 nível em objetos aninhados (ex.: cliente:{...}, customer:{...}, pedido:{...})
  for (const k of Object.keys(obj)) {
    const child = obj[k];
    if (child && typeof child === 'object' && !Array.isArray(child)) {
      const got = pick(child, names);
      if (got) return got;
    }
  }
  return null;
}

// Brasil / 9º dígito (mesma regra do whatsapp-send.js)
function normalizeWa(raw) {
  let n = String(raw || '').replace(/\D/g, '');
  if (!n) return '';
  if (n.length <= 11 && !n.startsWith('55')) n = '55' + n;           // acrescenta DDI Brasil
  if (n.startsWith('55') && n.length === 12) n = '55' + n.slice(2, 4) + '9' + n.slice(4);
  return n;
}

async function upsertCliente(waid, nome, email) {
  if (!waid) return null;
  const r = await sb('at_clientes?on_conflict=whatsapp_id', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
    body: JSON.stringify({ whatsapp_id: waid, nome: nome || 'Cliente', telefone: waid })
  });
  const row = Array.isArray(r.data) ? r.data[0] : r.data;
  return row && row.id ? row.id : null;
}

async function getOrCreateConversa(clienteId) {
  const f = await sb('at_conversas?cliente_id=eq.' + clienteId + '&status=neq.encerrada&select=id&order=ultima_msg_em.desc&limit=1');
  if (Array.isArray(f.data) && f.data.length) return f.data[0].id;
  const c = await sb('at_conversas', {
    method: 'POST', headers: { Prefer: 'return=representation' },
    body: JSON.stringify({ cliente_id: clienteId, canal: 'loja', status: 'aberta', nao_lida: true, ultima_msg_em: new Date().toISOString() })
  });
  const row = Array.isArray(c.data) ? c.data[0] : c.data;
  return row && row.id ? row.id : null;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'authorization, content-type');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const q = req.query || {};

  // ===== CONFIG (pra página /lojas.html): devolve a URL do webhook + últimos eventos =====
  if (req.method === 'GET' && q.config) {
    const email = await callerEmail((req.headers.authorization || '').replace('Bearer ', '').trim());
    if (!email) return res.status(403).json({ error: 'Faça login na suíte.' });
    const host = req.headers['x-forwarded-host'] || req.headers.host || 'sistema-grupo-aragao.vercel.app';
    const token = process.env.TROQUE_WEBHOOK_TOKEN || '';
    const url = 'https://' + host + '/api/troquecommerce-webhook' + (token ? ('?token=' + encodeURIComponent(token)) : '');
    let recentes = [];
    const r = await sb('loja_eventos?select=id,loja,evento_codigo,evento_label,cliente_nome,cliente_telefone,pedido,created_at&order=created_at.desc&limit=30');
    if (r.ok && Array.isArray(r.data)) recentes = r.data;
    return res.status(200).json({ ok: true, configurado: !!token, url, recentes, tabela: r.ok });
  }

  // ===== PING de saúde (TroqueCommerce testa a URL) =====
  if (req.method === 'GET') return res.status(200).send('ok');

  if (req.method !== 'POST') return res.status(405).json({ error: 'Método não permitido' });

  // valida o token embutido na URL
  const token = process.env.TROQUE_WEBHOOK_TOKEN;
  if (token && q.token !== token) return res.status(401).json({ error: 'token inválido' });

  // responde rápido depois de processar; nunca deixa estourar 500 pra plataforma não reenviar em loop
  try {
    let body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = { _raw: body }; } }
    body = body || {};

    // código/rótulo do evento
    const codigo = pick(body, ['event', 'evento', 'status', 'status_id', 'event_id', 'tipo', 'type', 'codigo', 'code']) || '';
    const label = EVENTOS[String(codigo)] || pick(body, ['event_name', 'evento_nome', 'descricao', 'description', 'status_name']) || ('Evento ' + (codigo || 'TroqueCommerce'));

    // dados do cliente / pedido (busca defensiva)
    const nome = pick(body, ['nome', 'name', 'cliente_nome', 'customer_name', 'nome_cliente', 'first_name']) || null;
    const email = pick(body, ['email', 'cliente_email', 'customer_email', 'e_mail']) || null;
    const telRaw = pick(body, ['telefone', 'phone', 'celular', 'whatsapp', 'cliente_telefone', 'customer_phone', 'telefone_principal', 'phone_number']) || null;
    const pedido = pick(body, ['pedido', 'order', 'numero_pedido', 'order_number', 'pedido_numero', 'codigo_pedido', 'order_id', 'numero']) || null;
    const waid = normalizeWa(telRaw);

    // 1) grava o evento cru (fonte da verdade; degradа com elegância se a tabela não existir)
    let conversaId = null;

    // 2) se tem telefone, leva pro painel de atendimento como nota do sistema
    if (waid) {
      const clienteId = await upsertCliente(waid, nome, email);
      if (clienteId) {
        conversaId = await getOrCreateConversa(clienteId);
        if (conversaId) {
          const nota = '🔁 ' + label + (pedido ? (' — pedido ' + pedido) : '') + ' (TroqueCommerce)';
          await sb('at_mensagens', {
            method: 'POST',
            body: JSON.stringify({
              conversa_id: conversaId, direcao: 'in', tipo: 'nota', conteudo: nota,
              autor: 'TroqueCommerce', meta: { loja: 'troquecommerce', evento: codigo, pedido }
            })
          });
          await sb('at_conversas?id=eq.' + conversaId, {
            method: 'PATCH',
            body: JSON.stringify({ nao_lida: true, ultima_msg_preview: nota.slice(0, 120), ultima_msg_em: new Date().toISOString() })
          });
        }
      }
    }

    // grava o registro na tabela de eventos de loja (não bloqueia se falhar)
    await sb('loja_eventos', {
      method: 'POST',
      body: JSON.stringify({
        loja: 'troquecommerce', evento_codigo: String(codigo || ''), evento_label: label,
        cliente_nome: nome, cliente_telefone: waid || null, cliente_email: email,
        pedido, conversa_id: conversaId, payload: body
      })
    });

    return res.status(200).json({ received: true });
  } catch (err) {
    console.error('troquecommerce-webhook erro:', err.message);
    return res.status(200).json({ received: true, error: err.message });
  }
}
