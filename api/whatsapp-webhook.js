// api/whatsapp-webhook.js
// Webhook do WhatsApp Cloud API (oficial da Meta).
// GET  = verificação do webhook (Meta chama com hub.challenge).
// POST = recebimento de mensagens → grava em at_clientes/at_conversas/at_mensagens
//        e, se o Chatbot IA estiver ATIVO, responde sozinho (modo robô).
//
// Env vars no Vercel:
//   WA_VERIFY_TOKEN, WA_ACCESS_TOKEN, WA_PHONE_NUMBER_ID
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

const GRAPH = 'https://graph.facebook.com/v20.0';
const SB  = () => process.env.SUPABASE_URL;
const KEY = () => process.env.SUPABASE_SERVICE_ROLE_KEY;

// Brasil / 9º dígito (mesma regra do whatsapp-send.js)
function normalizeWa(raw) {
  let n = String(raw || '').replace(/\D/g, '');
  if (n.startsWith('55') && n.length === 12) { n = '55' + n.slice(2, 4) + '9' + n.slice(4); }
  return n;
}

async function sbFetch(path, opts = {}) {
  const r = await fetch(SB() + '/rest/v1/' + path, {
    ...opts,
    headers: {
      apikey: KEY(),
      Authorization: 'Bearer ' + KEY(),
      'Content-Type': 'application/json',
      ...(opts.headers || {})
    }
  });
  const txt = await r.text();
  let data = null; try { data = txt ? JSON.parse(txt) : null; } catch (e) { data = txt; }
  if (!r.ok) throw new Error('Supabase ' + r.status + ': ' + JSON.stringify(data));
  return data;
}

// upsert cliente por whatsapp_id, retorna o registro
async function upsertCliente({ waid, nome, telefone }) {
  const rows = await sbFetch('at_clientes?on_conflict=whatsapp_id', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
    body: JSON.stringify({ whatsapp_id: waid, nome: nome || 'Cliente', telefone: telefone || null })
  });
  return Array.isArray(rows) ? rows[0] : rows;
}

// acha conversa aberta/pendente do cliente, senão cria
async function getOrCreateConversa(clienteId) {
  const found = await sbFetch(
    'at_conversas?cliente_id=eq.' + clienteId + '&status=neq.encerrada&select=id&order=ultima_msg_em.desc&limit=1'
  );
  if (Array.isArray(found) && found.length) return found[0].id;
  const created = await sbFetch('at_conversas', {
    method: 'POST',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify({
      cliente_id: clienteId,
      canal: 'whatsapp_oficial',
      status: 'aberta',
      nao_lida: true,
      janela_expira_em: new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
      ultima_msg_em: new Date().toISOString()
    })
  });
  return (Array.isArray(created) ? created[0] : created).id;
}

// extrai texto/tipo de uma mensagem do WhatsApp
function parseMsg(m) {
  switch (m.type) {
    case 'text':     return { tipo: 'texto',      conteudo: m.text?.body || '' };
    case 'reaction': return { tipo: 'texto',      conteudo: m.reaction?.emoji ? ('reagiu ' + m.reaction.emoji) : '[reação removida]' };
    case 'sticker':  return { tipo: 'imagem',     conteudo: '[figurinha]' };
    case 'image':    return { tipo: 'imagem',     conteudo: m.image?.caption || '[imagem]' };
    case 'audio':    return { tipo: 'audio',      conteudo: '[áudio]' };
    case 'document': return { tipo: 'documento',  conteudo: m.document?.filename || '[documento]' };
    case 'video':    return { tipo: 'documento',  conteudo: m.video?.caption || '[vídeo]' };
    case 'location': return { tipo: 'texto',      conteudo: '[localização]' };
    case 'contacts': return { tipo: 'texto',      conteudo: '[contato]' };
    case 'unsupported': return { tipo: 'texto',   conteudo: '[mensagem que o WhatsApp não repassa (encaminhada/enquete/etc.)]' };
    default:         return { tipo: 'texto',      conteudo: '[mensagem não suportada pelo WhatsApp]' };
  }
}

// ===== MÍDIA: baixa imagem/sticker do WhatsApp e sobe no storage (bucket at-media) =====
async function baixarMidia(mediaId){
  try{
    if(!process.env.WA_ACCESS_TOKEN) return null;
    const r1 = await fetch(GRAPH + '/' + mediaId, { headers: { Authorization: 'Bearer ' + process.env.WA_ACCESS_TOKEN } });
    const j1 = await r1.json(); if(!j1 || !j1.url) return null;
    const r2 = await fetch(j1.url, { headers: { Authorization: 'Bearer ' + process.env.WA_ACCESS_TOKEN } });
    if(!r2.ok) return null;
    const buf = Buffer.from(await r2.arrayBuffer());
    const mime = String(j1.mime_type || r2.headers.get('content-type') || 'image/jpeg').split(';')[0];
    const ext = (mime.split('/')[1] || 'jpg');
    const path = 'in/' + Date.now() + '-' + String(mediaId).slice(-10) + '.' + ext;
    const up = await fetch(SB() + '/storage/v1/object/at-media/' + path, {
      method: 'POST',
      headers: { apikey: KEY(), Authorization: 'Bearer ' + KEY(), 'Content-Type': mime, 'x-upsert': 'true' },
      body: buf
    });
    if(!up.ok) return null;
    return { url: SB() + '/storage/v1/object/public/at-media/' + path, mime };
  }catch(e){ console.error('baixarMidia:', e.message); return null; }
}

// ===== CHATBOT IA: responde sozinho quando ATIVO e ninguém humano assumiu =====
async function maybeBotReply(conversaId, clienteNome, inboundText, waid, host) {
  try {
    if (!process.env.WA_ACCESS_TOKEN || !process.env.WA_PHONE_NUMBER_ID) return;
    let cfgRows = null; try { cfgRows = await sbFetch('at_chatbot?id=eq.1&select=ativo,nome,handoff_termos'); } catch (e) { return; }
    const cfg = Array.isArray(cfgRows) ? cfgRows[0] : cfgRows;
    if (!cfg || !cfg.ativo) return;                                   // chatbot desligado -> nada

    let convRows = null; try { convRows = await sbFetch('at_conversas?id=eq.' + conversaId + '&select=modo,atendente_id'); } catch (e) {}
    const cv = Array.isArray(convRows) ? convRows[0] : convRows;
    if (cv && (cv.modo === 'humano' || cv.atendente_id)) return;      // humano assumiu -> robô quieto

    // handoff por palavra-chave (antes de gastar IA)
    const termos = String(cfg.handoff_termos || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
    if (termos.some(t => t && String(inboundText || '').toLowerCase().includes(t))) {
      await sbFetch('at_conversas?id=eq.' + conversaId, { method: 'PATCH', body: JSON.stringify({ modo: 'humano', nao_lida: true }) });
      await sbFetch('at_mensagens', { method: 'POST', body: JSON.stringify({ conversa_id: conversaId, direcao: 'in', tipo: 'nota', conteudo: '🙋 Cliente pediu atendente humano (palavra-chave). Robô pausado.', autor: 'Sistema' }) });
      return;
    }

    // histórico (últimas 12 mensagens de texto)
    let rows = []; try { rows = await sbFetch('at_mensagens?conversa_id=eq.' + conversaId + '&select=direcao,conteudo,tipo&order=enviada_em.desc&limit=12'); } catch (e) {}
    const msgs = (Array.isArray(rows) ? rows : []).reverse()
      .filter(m => (m.tipo === 'texto' || !m.tipo) && (m.direcao === 'in' || m.direcao === 'out'))
      .map(m => ({ role: m.direcao === 'out' ? 'assistant' : 'user', content: m.conteudo || '' }));
    if (!msgs.length) return;

    // chama o cérebro (auth interna via service role)
    const r = await fetch('https://' + host + '/api/chatbot-reply', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-internal': KEY() },
      body: JSON.stringify({ mensagens: msgs, cliente: { nome: clienteNome } })
    });
    let j = {}; try { j = await r.json(); } catch (e) {}
    if (!r.ok || !j.reply) return;                                    // sem resposta -> deixa pro humano (fica não lida)

    // envia a resposta pelo WhatsApp
    const to = normalizeWa(waid);
    await fetch(GRAPH + '/' + process.env.WA_PHONE_NUMBER_ID + '/messages', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + process.env.WA_ACCESS_TOKEN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'text', text: { body: String(j.reply) } })
    });
    // grava a resposta do robô e mantém o modo bot
    await sbFetch('at_mensagens', { method: 'POST', body: JSON.stringify({ conversa_id: conversaId, direcao: 'out', tipo: 'texto', conteudo: j.reply, autor: '🤖 ' + (cfg.nome || 'Assistente'), meta: { bot: true } }) });
    await sbFetch('at_conversas?id=eq.' + conversaId, { method: 'PATCH', body: JSON.stringify({ modo: 'bot', ultima_msg_preview: String(j.reply).slice(0, 120), ultima_msg_em: new Date().toISOString(), nao_lida: false }) });
    if (j.handoff) { await sbFetch('at_conversas?id=eq.' + conversaId, { method: 'PATCH', body: JSON.stringify({ modo: 'humano', nao_lida: true }) }); }
  } catch (e) { console.error('bot reply erro:', e.message); }
}

export default async function handler(req, res) {
  // 1) Verificação (GET) exigida pela Meta ao configurar o webhook
  if (req.method === 'GET') {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];
    if (mode === 'subscribe' && token === process.env.WA_VERIFY_TOKEN) {
      return res.status(200).send(challenge);
    }
    return res.status(403).send('Forbidden');
  }

  if (req.method !== 'POST') return res.status(405).json({ error: 'Método não permitido' });

  const host = req.headers['x-forwarded-host'] || req.headers.host || 'producao-dra-charm.vercel.app';

  // 2) Recebimento (POST). Responder 200 rápido é importante pra Meta não reenviar.
  try {
    let body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }

    const entries = body?.entry || [];
    for (const entry of entries) {
      for (const change of (entry.changes || [])) {
        const value = change.value || {};
        const numeroDestino = value?.metadata?.phone_number_id;
        if (process.env.WA_PHONE_NUMBER_ID && numeroDestino && numeroDestino !== process.env.WA_PHONE_NUMBER_ID) {
          continue;
        }
        const messages = value.messages || [];
        const contatoNome = value.contacts?.[0]?.profile?.name || null;
        for (const m of messages) {
          const waid = m.from;                       // wa_id (telefone do cliente)
          const { tipo, conteudo } = parseMsg(m);
          // imagem/figurinha do cliente: baixa e guarda no storage
          let midia_url = null, midia_tipo = null;
          if ((m.type === 'image' && m.image && m.image.id) || (m.type === 'sticker' && m.sticker && m.sticker.id)) {
            const dl = await baixarMidia(m.type === 'image' ? m.image.id : m.sticker.id);
            if (dl) { midia_url = dl.url; midia_tipo = 'imagem'; }
          }
          const cliente = await upsertCliente({ waid, nome: contatoNome, telefone: waid });
          const conversaId = await getOrCreateConversa(cliente.id);
          await sbFetch('at_mensagens', {
            method: 'POST',
            body: JSON.stringify({
              conversa_id: conversaId, direcao: 'in', tipo, conteudo, midia_url, midia_tipo,
              autor: contatoNome || waid, meta: { wa_id: waid, wamid: m.id },
              enviada_em: new Date(Number(m.timestamp) * 1000 || Date.now()).toISOString()
            })
          });
          await sbFetch('at_conversas?id=eq.' + conversaId, {
            method: 'PATCH',
            body: JSON.stringify({
              nao_lida: true,
              ultima_msg_preview: conteudo.slice(0, 120),
              ultima_msg_em: new Date().toISOString(),
              janela_expira_em: new Date(Date.now() + 24 * 3600 * 1000).toISOString()
            })
          });
          // Chatbot IA: só reage a mensagem de TEXTO do cliente (não figurinha/áudio/etc)
          if (m.type === 'text') {
            await maybeBotReply(conversaId, contatoNome || 'Cliente', conteudo, waid, host);
          }
        }
      }
    }
    return res.status(200).json({ received: true });
  } catch (err) {
    console.error('whatsapp-webhook erro:', err.message);
    return res.status(200).json({ received: true, error: err.message });
  }
}
