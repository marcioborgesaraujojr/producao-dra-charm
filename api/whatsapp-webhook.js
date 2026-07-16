// api/whatsapp-webhook.js
// Webhook do WhatsApp Cloud API (oficial da Meta).
// GET  = verificação do webhook (Meta chama com hub.challenge).
// POST = recebimento de mensagens → grava em at_clientes/at_conversas/at_mensagens.
//
// Env vars no Vercel (o Marcio cadastra; NUNCA no código):
//   WA_VERIFY_TOKEN            (string qualquer que você define e repete na Meta)
//   SUPABASE_URL               (já existe)
//   SUPABASE_SERVICE_ROLE_KEY  (já existe)
//
// Configurar na Meta: URL do webhook = https://producao-dra-charm.vercel.app/api/whatsapp-webhook
// Campo a assinar: "messages".

const SB  = () => process.env.SUPABASE_URL;
const KEY = () => process.env.SUPABASE_SERVICE_ROLE_KEY;

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
    case 'image':    return { tipo: 'imagem',     conteudo: m.image?.caption || '[imagem]' };
    case 'audio':    return { tipo: 'audio',      conteudo: '[áudio]' };
    case 'document': return { tipo: 'documento',  conteudo: m.document?.filename || '[documento]' };
    case 'video':    return { tipo: 'documento',  conteudo: m.video?.caption || '[vídeo]' };
    default:         return { tipo: 'texto',      conteudo: '[' + m.type + ']' };
  }
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

  // 2) Recebimento (POST). Responder 200 rápido é importante pra Meta não reenviar.
  try {
    let body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }

    const entries = body?.entry || [];
    for (const entry of entries) {
      for (const change of (entry.changes || [])) {
        const value = change.value || {};
        const messages = value.messages || [];
        const contatoNome = value.contacts?.[0]?.profile?.name || null;
        for (const m of messages) {
          const waid = m.from;                       // wa_id (telefone do cliente)
          const { tipo, conteudo } = parseMsg(m);
          const cliente = await upsertCliente({ waid, nome: contatoNome, telefone: waid });
          const conversaId = await getOrCreateConversa(cliente.id);
          await sbFetch('at_mensagens', {
            method: 'POST',
            body: JSON.stringify({
              conversa_id: conversaId, direcao: 'in', tipo, conteudo,
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
        }
      }
    }
    return res.status(200).json({ received: true });
  } catch (err) {
    // Mesmo com erro, responde 200 pra Meta não ficar reenviando em loop; loga pra debug.
    console.error('whatsapp-webhook erro:', err.message);
    return res.status(200).json({ received: true, error: err.message });
  }
}
